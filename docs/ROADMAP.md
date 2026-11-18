# Roadmap (in dependency order)
1. engine: mood + energy as the only core state; hunger, boredom, loneliness, accomplishment, joy, fear as decaying influences; novelty/habituation; interests and pursuits; rules fallback uses the same logic. Fix trinket ping-pong and hoarding.
2. items: open gifts. Free-text item -> one cheap appraisal call into a bounded schema (kind, small mood/energy effect, durability, description). Creatures can use, trade, talk about it.
3. library: per-creature shelf (limited slots) of notes/plans/SVG; public page + RSS; creature website page (static, filtered, no scripts or external links).
4. builder (DONE, see docs/BUILDER.md): guarded world-building proposals (bench, garden plot, flower box, lantern, sign); validated; daily limits; caps; human veto queue behind ADMIN_SECRET. Not yet: place renaming, an admin web page (API only).
5. payments: USD-priced closed-loop credits ledger, fake/testnet payment backend, x402-ready paid endpoint (testnet). Spend sinks: launch creature, launch website, shelf space. No real money yet.
6. outside: postcards out (mailbox + RSS), books in (public-domain shelf, request queue), real weather/date events; kiosk and email last.
Cross-cutting: safety (filter lists, veto queue, cost caps), qa (tests, review), deploy.
