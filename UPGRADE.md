# Wishclaw list management upgrade

The existing vanilla ES-module app now supports guided creation from scratch, pasted text, and JSON; adding/removing individual cards; and purchaser names and timestamps. Auth, recovery, the hosted catalog, list ownership/deletion, exports, searching, sorting, and existing Scryfall pricing remain in place.

## Deployment

1. Back up the Supabase database. Review the actual deployed `shopping_lists`, `shopping_list_items`, and `checklist_members` policies against `sql/supabase_modular_migration.sql`. The original membership-table creation policy is not included in this repository; the new migration relies on its existing approved-member mechanism.
2. Run **`sql/20261108_list_management.sql`** in Supabase SQL Editor as project owner. It requires the existing modular schema. Do not rerun the old baseline migration after this one: the old file would restore the previous create-list RPC definition.
3. Verify `shopping_lists`, `shopping_list_items`, and `wishclaw_profiles` are enabled under the `supabase_realtime` publication. The new migration adds items and profiles if the publication exists; the previous migration already adds lists.
4. Deploy `index.html`, `styles.css`, `app.js`, and **the entire `modules/` directory** together through the existing GitHub/Vercel workflow. Retain the existing assets, hosted catalog, and JSON templates. No framework, build step, runtime npm dependency, service-role key, new Auth provider, or new redirect URL is required.
5. Each approved user can set a friendly display name in List Management. Existing purchaser-less acquisitions remain legacy acquisitions. Missing profiles display “Checklist member”; deleted Auth users display “purchaser no longer available.”
6. Complete the live checks in `ACCEPTANCE.md` before treating this as production-verified. The migration and deployment have not been applied to the live project by this task.

The migration is transactional and repeatable. It adds nullable fields and a profile table, replaces the existing invoker creation RPC to support empty lists, adds an invoker add-item RPC, installs purchaser attribution, and grants approved members individual-item deletion. Existing list/item IDs, owners, purchases, notes and price fields are retained.

## Creation and card behavior

- **Start from scratch:** name an empty shared list, then use **+ Add Card**.
- **Paste a decklist:** supports `1 Sol Ring`, `1x Demonic Tutor`, bare names, headings, blank/comment lines, and `(SET) collector-number` suffixes. A trailing Moxfield `*F*` is preserved as a foil preference. Unknown lines remain visible. Correct any entry or explicitly remove it; validation failures never silently disappear.
- **JSON:** accepts bare card arrays and `{ "name": "...", "cards": [...] }`, including existing hosted templates. Name, category, notes, quantity and color identity are validated without truncation.
- **Scryfall:** autocomplete and single-card previews use documented endpoints; deck validation batches up to 75 collection identifiers and shares a request queue. Unrecognized names or unavailable API responses are flagged. The user must explicitly allow unverified names to save them. Invalid structural data cannot bypass validation. Set/collector mismatches are flagged rather than replaced with an unrelated card.
- **Duplicates:** optional merging combines entries only when name, category, notes, set and collector number match. Adding to a shared list merges only into an unpurchased entry. Already acquired entries remain separate. The RPC serializes additions to one list, checks quantity limits, and commits the merge atomically.
- **Printing metadata:** optional `setCode`, `collectorNumber`, and `scryfallId` persist to corresponding database columns. Requested printing is shown under the card. Existing price-search behavior is preserved: an estimate is not a guarantee of a seller's offer for a requested printing.
- Purchase and removal controls display confirmed server results. Failed writes retain the item and show an error. Realtime refreshes use the same state renderer.

## Security and compatibility

All new RPCs are `SECURITY INVOKER` with fixed empty search paths, explicit membership checks and RLS. Anonymous execution is revoked. The purchase trigger ignores supplied purchaser IDs/timestamps: only an actual false-to-true transition records `auth.uid()` and server time; unchecking clears both; an already purchased row preserves its existing attribution. Internal Auth-user deletion may clear the FK while retaining the historical timestamp. Changing an existing item's UUID or list UUID is rejected.

Profiles expose only UUIDs and chosen display names to approved members. Members can update only their own profile. Display names are not unique or verified identities; UUIDs remain authoritative. No email addresses are used in purchase attribution. The existing publishable Supabase key remains client-side; no service-role credentials were introduced.

All approved members retain the application's existing global shared-list access model. The new delete-item policy follows that same membership rule. Whole-list deletion remains restricted to its creator. If production has additional permissive policies not represented by the supplied SQL, audit those policies separately.

The dialogs use native HTML dialogs and datalist autocomplete. CSS includes narrow-screen layouts and touch targets, but iPhone/Safari layout, keyboard behavior and actual Supabase Realtime delivery require the live checks below. Production must load the new migration before deploying the new RPC consumers.

## Local verification

From the repository root, with Node 22 or newer:

```sh
npm install --prefix tests
npm test --prefix tests
```

These are test-only dependencies; Vercel does not need them. The suite uses JSDOM and an isolated in-memory PGlite PostgreSQL instance, not the live project. Authentication/Realtime/Scryfall transports are simulated in the interaction suite. The SQL migration, RLS checks and trigger are executed by the local PostgreSQL engine. The fixture omits the baseline's `CREATE EXTENSION pgcrypto` because PGlite provides `gen_random_uuid` but does not bundle pgcrypto; the new migration runs without modification.
