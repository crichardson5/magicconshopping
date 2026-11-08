-- MagicCon modular shared lists migration.
-- Run once in Supabase SQL Editor as project owner.
-- Preserves rows in the existing public.shopping_items table.
-- Requires the previously created public.checklist_members(user_id) table.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS public.shopping_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  legacy_code text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.shopping_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES public.shopping_lists(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  item_type text NOT NULL DEFAULT 'card' CHECK(item_type IN ('card','other')),
  deck text NOT NULL DEFAULT 'Unassigned',
  item_name text NOT NULL CHECK(char_length(item_name) BETWEEN 1 AND 250),
  quantity integer NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 999),
  notes text,
  color_identity jsonb CHECK(color_identity IS NULL OR jsonb_typeof(color_identity)='array'),
  purchased boolean NOT NULL DEFAULT false,
  estimated_price numeric(10,2) CHECK(estimated_price >= 0),
  price_paid numeric(10,2) CHECK(price_paid >= 0),
  legacy_key text UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_magiccon_items_list ON public.shopping_list_items(list_id, position);
ALTER TABLE public.shopping_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopping_list_items ENABLE ROW LEVEL SECURITY;
-- Explicitly grant only data-layer rights needed by the browser.
GRANT SELECT, INSERT, DELETE ON public.shopping_lists TO authenticated;
GRANT SELECT, UPDATE ON public.shopping_list_items TO authenticated;

DROP POLICY IF EXISTS "Members select lists" ON public.shopping_lists;
CREATE POLICY "Members select lists" ON public.shopping_lists FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.checklist_members m WHERE m.user_id=(SELECT auth.uid())));
DROP POLICY IF EXISTS "Members insert lists" ON public.shopping_lists;
CREATE POLICY "Members insert lists" ON public.shopping_lists FOR INSERT TO authenticated
 WITH CHECK (created_by=(SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.checklist_members m WHERE m.user_id=(SELECT auth.uid())));
DROP POLICY IF EXISTS "Creators delete lists" ON public.shopping_lists;
CREATE POLICY "Creators delete lists" ON public.shopping_lists FOR DELETE TO authenticated
 USING (created_by=(SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.checklist_members m WHERE m.user_id=(SELECT auth.uid())));
DROP POLICY IF EXISTS "Members select items" ON public.shopping_list_items;
CREATE POLICY "Members select items" ON public.shopping_list_items FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.checklist_members m WHERE m.user_id=(SELECT auth.uid())));
DROP POLICY IF EXISTS "Members update items" ON public.shopping_list_items;
CREATE POLICY "Members update items" ON public.shopping_list_items FOR UPDATE TO authenticated
 USING (EXISTS (SELECT 1 FROM public.checklist_members m WHERE m.user_id=(SELECT auth.uid())))
 WITH CHECK (EXISTS (SELECT 1 FROM public.checklist_members m WHERE m.user_id=(SELECT auth.uid())));

-- Add each old category as a list (the old database is not modified).
-- This conditional step supports installations that have not imported the earlier SQL yet.
DO $legacy$
DECLARE row record; l_id uuid;
BEGIN
 IF to_regclass('public.shopping_items') IS NOT NULL THEN
   FOR row IN EXECUTE 'SELECT DISTINCT list_name FROM public.shopping_items ORDER BY list_name' LOOP
     INSERT INTO public.shopping_lists(name,legacy_code)
       VALUES(row.list_name, 'legacy:' || row.list_name)
       ON CONFLICT(legacy_code) DO UPDATE SET name=excluded.name
       RETURNING id INTO l_id;
     EXECUTE $copy$
       INSERT INTO public.shopping_list_items
         (list_id, position, item_type, deck, item_name, quantity, notes, purchased, estimated_price, price_paid, legacy_key)
       SELECT $1, row_number() OVER(ORDER BY id)::integer,
              CASE WHEN item_type='card' THEN 'card' ELSE 'other' END,
              CASE WHEN item_type='card' THEN list_name ELSE 'Shopping extras' END,
              card_name, quantity, notes, purchased, estimated_price, price_paid, item_key
       FROM public.shopping_items WHERE list_name=$2
       ON CONFLICT(legacy_key) DO NOTHING
     $copy$ USING l_id,row.list_name;
   END LOOP;
 END IF;
END $legacy$;

-- Auto-maintain modified timestamp, including updates from browsers.
CREATE OR REPLACE FUNCTION public.magiccon_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS magiccon_touch_items ON public.shopping_list_items;
CREATE TRIGGER magiccon_touch_items BEFORE UPDATE ON public.shopping_list_items
 FOR EACH ROW EXECUTE FUNCTION public.magiccon_touch_updated_at();

-- Atomic JSON import. Invoker identity and RLS are enforced, and incomplete imports roll back.
CREATE OR REPLACE FUNCTION public.create_shopping_list(p_name text,p_cards jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE new_id uuid; elem jsonb; idx integer := 0; quantity integer; deck_name text; card_name text; note_text text; identity jsonb;
BEGIN
 IF (SELECT auth.uid()) IS NULL OR NOT EXISTS (
   SELECT 1 FROM public.checklist_members WHERE user_id=(SELECT auth.uid())
 ) THEN RAISE EXCEPTION 'You are not an approved checklist member'; END IF;
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120
   THEN RAISE EXCEPTION 'List name must be 1–120 characters'; END IF;
 IF p_cards IS NULL OR jsonb_typeof(p_cards)<>'array' OR jsonb_array_length(p_cards) NOT BETWEEN 1 AND 500
   THEN RAISE EXCEPTION 'Provide 1–500 cards'; END IF;
 INSERT INTO public.shopping_lists(name,created_by) VALUES(btrim(p_name), (SELECT auth.uid())) RETURNING id INTO new_id;
 FOR elem IN SELECT value FROM jsonb_array_elements(p_cards) LOOP
   idx:=idx+1;
   IF jsonb_typeof(elem)<>'object' THEN RAISE EXCEPTION 'Invalid card at position %',idx; END IF;
   card_name:=btrim(coalesce(elem->>'name',''));
   deck_name:=coalesce(nullif(btrim(elem->>'deck'),''),'Unassigned');
   note_text:=coalesce(elem->>'note','');
   quantity:=coalesce((elem->>'qty')::integer,1);
   identity:=elem->'colorIdentity';
   IF length(card_name) NOT BETWEEN 1 AND 250 OR length(deck_name)>150 OR length(note_text)>1500 OR quantity NOT BETWEEN 1 AND 999
      THEN RAISE EXCEPTION 'Invalid card values at position %',idx; END IF;
   IF identity IS NOT NULL AND jsonb_typeof(identity)<>'null' AND (
     jsonb_typeof(identity)<>'array' OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(identity) AS x(value) WHERE x.value NOT IN ('W','U','B','R','G'))
   ) THEN RAISE EXCEPTION 'Invalid color identity at position %',idx; END IF;
   INSERT INTO public.shopping_list_items(list_id,position,item_type,deck,item_name,quantity,notes,color_identity)
     VALUES(new_id,idx,'card',deck_name,card_name,quantity,note_text,CASE WHEN jsonb_typeof(identity)='null' THEN NULL ELSE identity END);
 END LOOP;
 RETURN new_id;
END $$;
-- SECURITY INVOKER RPC requires permission to insert items, but direct inserts have no RLS policy.
-- Provide an INSERT policy tied to approved membership. This also allows later modular UI add-card actions.
GRANT INSERT ON public.shopping_list_items TO authenticated;
DROP POLICY IF EXISTS "Members insert items" ON public.shopping_list_items;
CREATE POLICY "Members insert items" ON public.shopping_list_items FOR INSERT TO authenticated
 WITH CHECK (EXISTS (SELECT 1 FROM public.checklist_members m WHERE m.user_id=(SELECT auth.uid())));
GRANT EXECUTE ON FUNCTION public.create_shopping_list(text,jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_shopping_list(text,jsonb) FROM PUBLIC, anon;

-- Enable change broadcasts (idempotent when already added).
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='shopping_lists') THEN
   ALTER PUBLICATION supabase_realtime ADD TABLE public.shopping_lists;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='shopping_list_items') THEN
   ALTER PUBLICATION supabase_realtime ADD TABLE public.shopping_list_items;
 END IF;
END $$;
COMMIT;
