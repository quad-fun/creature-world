# Roadmap (in dependency order)
1. engine: mood + energy as the only core state; hunger, boredom, loneliness, accomplishment, joy, fear as decaying influences; novelty/habituation; interests and pursuits; rules fallback uses the same logic. Fix trinket ping-pong and hoarding.
2. items: open gifts. Free-text item -> one cheap appraisal call into a bounded schema (kind, small mood/energy effect, durability, description). Creatures can use, trade, talk about it.
3. library: per-creature shelf (limited slots) of notes/plans/SVG; public page + RSS; creature website page (static, filtered, no scripts or external links).
4. builder (DONE, see docs/BUILDER.md): guarded world-building proposals (bench, garden plot, flower box, lantern, sign); validated; daily limits; caps; human veto queue behind ADMIN_SECRET. Not yet: place renaming, an admin web page (API only).
5. payments: USD-priced closed-loop credits ledger, fake/testnet payment backend, x402-ready paid endpoint (testnet). Spend sinks: launch creature, launch website, shelf space. No real money yet.
6. outside (DONE, see docs/OUTSIDE.md): weather/date events (seeded fake, optional live read), books in (8 public-domain titles, `read_book`, human-approved request queue), postcards out (public page + Atom feed, visitor postcards from elsewhere). Not yet: real email and kiosk (safety design in OUTSIDE.md), an admin web page for book requests.
Cross-cutting: safety (filter lists, veto queue, cost caps), qa (tests, review), deploy.

Engine tweaks 1 (branch engine/tweaks-1): stall habit rule (max 2 sells of one kind in a row, price floor 0.55, faster recovery), tea at the bakery (1 coin, comfort, habituation), server-side auto-walk for sell/buy_food/craft, one bounded model decision per creature per catch-up, varied rules wording, prompt says only listed items exist. New field `sellRun` (default in migrate.ts).
