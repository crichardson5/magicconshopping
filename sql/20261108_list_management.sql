-- Wishclaw list tools and server-enforced purchase attribution.
-- Apply AFTER supabase_modular_migration.sql. Repeatable; no rows are backfilled/deleted.
BEGIN;
ALTER TABLE public.shopping_list_items
  ADD COLUMN IF NOT EXISTS purchased_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchased_at timestamptz,
  ADD COLUMN IF NOT EXISTS set_code text,
  ADD COLUMN IF NOT EXISTS collector_number text,
  ADD COLUMN IF NOT EXISTS scryfall_id uuid;

CREATE TABLE IF NOT EXISTS public.wishclaw_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 60)
);
ALTER TABLE public.wishclaw_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wishclaw_profiles FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.wishclaw_profiles TO authenticated;
DROP POLICY IF EXISTS "Approved members read profiles" ON public.wishclaw_profiles;
CREATE POLICY "Approved members read profiles" ON public.wishclaw_profiles FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id = (SELECT auth.uid())));
DROP POLICY IF EXISTS "Members create own profile" ON public.wishclaw_profiles;
CREATE POLICY "Members create own profile" ON public.wishclaw_profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id = (SELECT auth.uid())));
DROP POLICY IF EXISTS "Members update own profile" ON public.wishclaw_profiles;
CREATE POLICY "Members update own profile" ON public.wishclaw_profiles FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (user_id = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id = (SELECT auth.uid())));

-- Applies equally to RPC calls and direct browser writes. Supplied attribution is ignored.
CREATE OR REPLACE FUNCTION public.wishclaw_purchase_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.list_id IS DISTINCT FROM OLD.list_id THEN
      RAISE EXCEPTION 'Item identity and list cannot be changed';
    END IF;
    -- Permit only the internal FK cleanup when an administrator deletes an Auth user.
    IF pg_trigger_depth() > 1 AND auth.uid() IS NULL AND NEW.purchased_by IS NULL AND OLD.purchased_by IS NOT NULL THEN
      NEW.purchased_at := OLD.purchased_at;
      RETURN NEW;
    END IF;
    IF NEW.purchased AND OLD.purchased THEN
      NEW.purchased_by := OLD.purchased_by;
      NEW.purchased_at := OLD.purchased_at;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.purchased THEN
    IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id = auth.uid()) THEN
      RAISE EXCEPTION 'Approved authentication is required to mark a purchase';
    END IF;
    NEW.purchased_by := auth.uid();
    NEW.purchased_at := now();
  ELSE
    NEW.purchased_by := NULL;
    NEW.purchased_at := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wishclaw_purchase_attribution ON public.shopping_list_items;
CREATE TRIGGER wishclaw_purchase_attribution BEFORE INSERT OR UPDATE ON public.shopping_list_items
  FOR EACH ROW EXECUTE FUNCTION public.wishclaw_purchase_attribution();
REVOKE ALL ON FUNCTION public.wishclaw_purchase_attribution() FROM PUBLIC, anon, authenticated;

GRANT DELETE ON public.shopping_list_items TO authenticated;
DROP POLICY IF EXISTS "Members delete individual items" ON public.shopping_list_items;
CREATE POLICY "Members delete individual items" ON public.shopping_list_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id = (SELECT auth.uid())));

-- Central server validation. No truncation and no client-supplied purchase/ownership fields.
CREATE OR REPLACE FUNCTION public.wishclaw_normalize_card(p_card jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_name text; v_deck text; v_note text; v_qty integer; v_identity jsonb;
  v_set text; v_number text; v_id uuid;
BEGIN
  IF p_card IS NULL OR jsonb_typeof(p_card) <> 'object' THEN RAISE EXCEPTION 'Expected a card object'; END IF;
  v_name := btrim(coalesce(p_card->>'name', ''));
  v_deck := coalesce(nullif(btrim(p_card->>'deck'), ''), 'Unassigned');
  v_note := coalesce(p_card->>'note', '');
  IF coalesce(p_card->>'qty', '1') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Quantity must be an integer'; END IF;
  v_qty := coalesce((p_card->>'qty')::integer, 1);
  IF length(v_name) NOT BETWEEN 1 AND 250 OR length(v_deck)>150 OR length(v_note)>1500 OR v_qty NOT BETWEEN 1 AND 999 THEN
    RAISE EXCEPTION 'Invalid card name, quantity, category or notes';
  END IF;
  v_identity := coalesce(p_card->'colorIdentity', 'null'::jsonb);
  IF jsonb_typeof(v_identity) <> 'null' THEN
    IF jsonb_typeof(v_identity) <> 'array' THEN RAISE EXCEPTION 'Color identity must be an array'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_identity) x(value)
      WHERE jsonb_typeof(x.value) <> 'string' OR x.value #>> '{}' NOT IN ('W','U','B','R','G')) THEN
      RAISE EXCEPTION 'Invalid color identity';
    END IF;
  END IF;
  v_set := lower(nullif(btrim(p_card->>'setCode'), ''));
  v_number := nullif(btrim(p_card->>'collectorNumber'), '');
  IF v_set IS NOT NULL AND v_set !~ '^[a-z0-9]{2,10}$' THEN RAISE EXCEPTION 'Invalid set code'; END IF;
  IF length(v_number)>30 OR (v_number IS NOT NULL AND v_set IS NULL) THEN RAISE EXCEPTION 'Invalid collector number'; END IF;
  v_id := nullif(p_card->>'scryfallId', '')::uuid;
  RETURN jsonb_build_object('name',v_name,'deck',v_deck,'note',v_note,'qty',v_qty,
    'colorIdentity',v_identity,'setCode',v_set,'collectorNumber',v_number,'scryfallId',v_id);
END $$;
REVOKE ALL ON FUNCTION public.wishclaw_normalize_card(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wishclaw_normalize_card(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_shopping_list_item(p_list_id uuid, p_card jsonb, p_merge boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c jsonb; v_id uuid; v_quantity integer; v_position integer;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id=auth.uid()) THEN
    RAISE EXCEPTION 'You are not an approved checklist member';
  END IF;
  -- Serializes additions to the same list, including duplicate merge decisions.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_list_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM public.shopping_lists WHERE id=p_list_id) THEN RAISE EXCEPTION 'List not found or access denied'; END IF;
  c := public.wishclaw_normalize_card(p_card);
  IF p_merge THEN
    SELECT id, quantity INTO v_id, v_quantity FROM public.shopping_list_items
      WHERE list_id=p_list_id AND item_type='card' AND NOT purchased
      AND lower(item_name)=lower(c->>'name') AND lower(deck)=lower(c->>'deck')
      AND coalesce(notes,'')=c->>'note'
      AND set_code IS NOT DISTINCT FROM (c->>'setCode')
      AND collector_number IS NOT DISTINCT FROM (c->>'collectorNumber')
      ORDER BY position,id LIMIT 1 FOR UPDATE;
    IF v_id IS NOT NULL THEN
      IF v_quantity+(c->>'qty')::integer > 999 THEN RAISE EXCEPTION 'Merged quantity exceeds 999'; END IF;
      UPDATE public.shopping_list_items SET quantity=v_quantity+(c->>'qty')::integer WHERE id=v_id;
      RETURN v_id;
    END IF;
  END IF;
  IF (SELECT count(*) FROM public.shopping_list_items WHERE list_id=p_list_id)>=500 THEN RAISE EXCEPTION 'A list can contain at most 500 entries'; END IF;
  SELECT coalesce(max(position),0)+1 INTO v_position FROM public.shopping_list_items WHERE list_id=p_list_id;
  INSERT INTO public.shopping_list_items(list_id,position,item_type,deck,item_name,quantity,notes,color_identity,set_code,collector_number,scryfall_id)
    VALUES(p_list_id,v_position,'card',c->>'deck',c->>'name',(c->>'qty')::integer,c->>'note',
      nullif(c->'colorIdentity','null'::jsonb),c->>'setCode',c->>'collectorNumber',(c->>'scryfallId')::uuid)
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.add_shopping_list_item(uuid,jsonb,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_shopping_list_item(uuid,jsonb,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_shopping_list(p_name text, p_cards jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_id uuid; c jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.checklist_members WHERE user_id=auth.uid()) THEN
    RAISE EXCEPTION 'You are not an approved checklist member';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'List name must be 1–120 characters'; END IF;
  IF p_cards IS NULL OR jsonb_typeof(p_cards)<>'array' THEN RAISE EXCEPTION 'Cards must be an array'; END IF;
  IF jsonb_array_length(p_cards)>500 THEN RAISE EXCEPTION 'Provide at most 500 cards'; END IF;
  INSERT INTO public.shopping_lists(name,created_by) VALUES(btrim(p_name),auth.uid()) RETURNING id INTO v_id;
  FOR c IN SELECT value FROM jsonb_array_elements(p_cards) LOOP
    PERFORM public.add_shopping_list_item(v_id,c,false);
  END LOOP;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.create_shopping_list(text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_shopping_list(text,jsonb) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='wishclaw_profiles') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.wishclaw_profiles;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='shopping_list_items') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.shopping_list_items;
    END IF;
  END IF;
END $$;
COMMIT;
