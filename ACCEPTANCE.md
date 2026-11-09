# Acceptance record and release checklist

Date: 2026-11-08. Changes are local and uncommitted; no migration or deployment was applied to live Supabase/Vercel.

## Completed locally

- [x] Parse all five ES modules and verify every literal frontend element ID; reject duplicate IDs.
- [x] Execute the new SQL migration repeatedly in local PostgreSQL without modifying the migration.
- [x] Preserve legacy IDs, ownership, purchase statuses, timestamps and price estimates through migration and subsequent workflows.
- [x] Create an empty shared list, then add cards through the application UI handlers.
- [x] Import a Wishclaw JSON object through the creation preview; validate bare arrays in the normalization tests; open existing hosted templates in the same guided flow.
- [x] Parse representative Moxfield/plain-text quantities, headings, blank lines, set/collector suffixes, malformed quantities, unknown lines and duplicates.
- [x] Flag an unrecognized card, correct it, revalidate it, and create the list with merged quantities.
- [x] Add, merge, and remove cards; simulate failed add/create/delete writes and retain the review or existing item instead of indicating success.
- [x] Mark/unmark with two authenticated UUIDs in local PostgreSQL: verify the correct actor and server timestamp, clear both on uncheck, and reject forged attribution while purchased remains true.
- [x] Render changes in two independent DOM sessions through a simulated Realtime event transport backed by local PostgreSQL.
- [x] Save/read friendly profiles and reject writes to another member's profile; preserve legacy and missing-profile fallback labels.
- [x] Reject anonymous/unapproved RPC and direct table writes; retain creator-only whole-list deletion and approved individual-item deletion.
- [x] Exercise search and color sorting after importing and adding cards.
- [x] Verify publication membership for lists, items and profiles in local PostgreSQL.
- [x] Read-only live Scryfall collection/autocomplete requests returned HTTP 200 and the expected response shapes. The collection response correctly distinguished a requested printing whose collector number belonged to another card. This does not verify browser CORS behavior.

Commands used: `node --experimental-vm-modules tests/frontend.cjs` with test-only packages supplied via `NODE_PATH`; `git diff --check`.

## Must be completed against staging/live Supabase and real browsers

- [ ] Apply the migration in a staging copy; compare before/after row counts and representative historical lists, IDs, owners, purchase fields and prices. Run it a second time.
- [ ] Sign in with two approved accounts in separate browser profiles. Confirm an unapproved account cannot see list data; confirm anonymous access is rejected.
- [ ] Exercise password-link requests, recovery redirect, password change, sign-out and sign-in on the deployed origin. Existing Supabase redirect allowlisting must remain intact.
- [ ] Create an empty list; import JSON and a hosted template; paste real Moxfield text. Inspect quantities, headings, foil notes, and set/collector fields. Try unknown/malformed entries and the explicit unverified option.
- [ ] Add a card, try both duplicate policies, add a duplicate of an acquired card, and confirm it stays separate. Remove just one selected item; cancel a removal as well.
- [ ] Mark a card as account A and see A's display name/timestamp in B's browser without refreshing. Uncheck as B and confirm both fields clear in both sessions. Check as B and confirm attribution changes to B.
- [ ] Change a display name and confirm existing attribution refreshes in the other browser. A member without a profile should display a generic name rather than their email.
- [ ] With normal authenticated client credentials, attempt forged purchaser UUID/timestamp, another user's profile update, unapproved insert/update/delete/RPC calls, and deletion of someone else's whole list. Confirm production RLS/trigger rejection or preservation matches the local tests.
- [ ] Disconnect/reconnect network while checking and deleting cards. Confirm failures are visible, no false success occurs, and server state wins after reconnect/refresh.
- [ ] Verify actual Supabase Realtime INSERT/UPDATE/DELETE events for items, lists and profiles. The local suite simulates transport; it does not establish live delivery or Realtime authorization.
- [ ] Run existing price/color lookups and download CSV/JSON exports. Ensure historical purchase statuses and pricing remain intact.
- [ ] Test iPhone Safari at 375/390px and desktop browsers: dialog scrolling, native autocomplete, keyboard focus/Escape, labels, touch targets, table horizontal scrolling, rotation, and long names. Confirm no controls escape the viewport.

Chrome launch was attempted but blocked by the execution sandbox. No rendered mobile-layout or real-browser accessibility claim is made. No production credentials or test accounts were supplied; hosted Auth/Realtime and production RLS remain unverified.
