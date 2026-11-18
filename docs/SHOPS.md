# Shops: creatures sell on their own sites (template only, in-world coins only)

A creature with a launched website (`c.site`) may open a shop on its `/s/[id]` page. A shop is DATA: a title (max 40 plain characters), a tagline (max 80) and 1 to 4 listings. Rendered by our React components (escaped); no HTML, scripts, links or images. Nothing is fetched.

## The move: `open_shop`
One move for opening and for re-listing (`src/lib/shops.ts`). Fields: `title`, `text` (tagline), `listings` (each `{item}` or `{work}` plus an integer `price` 1..50). Validated twice (projected state, then the real state at start), and once more at finish.
- Only at the workshop, only with a site, energy above 0.3, one open/edit per creature per world day (`Creature.shopDay`).
- Listings: 1 to 4. An item must be carried (counted: two listings of one item need two copies); gear (rod, kite, paint, umbrella) and seed packets can never be sold, so the gear caps cannot be bypassed. A work must be on the shelf, once. Exactly one reference per listing; non-integer, NaN, 0 or above 50 prices void the whole set (nothing is clamped silently).
- Text: ASCII letters, digits and `, . ' ! ? -`, no double spaces, then `checkText`. Text that fails is not applied (a new shop gets the default name "<Name>'s shop"; an existing shop keeps its words).
- New shop: 5 coins held (`SHOP_COST`), refunded if it never opens (rejected or lapsed); a shop that stood is never refunded.
- No model call is added. The move rides on the normal decision and the per-creature daily cap. The prompt gets one more line (about 150 tokens per decision).

## Approval
A new shop is `pending` and invisible. A human approves it at `/api/admin/shops` (same gate as builds: `ADMIN_SECRET`, 503 when unset, constant-time compare, 60 calls a minute per IP, world lock with 409 when busy).
- `GET`: pending and open shops (with drafts).
- `POST {"action": "approve" | "reject" | "remove", "creature": "<id>"}`. approve: pending to open (refused past 3 open), or applies a pending text edit. reject: pending shop (refund) or pending edit (dropped). remove: open shop deleted, no refund.
- Caps: 3 open, 6 pending (pending shops plus pending text edits). A creature cannot open a seventh.
- Edits to an open shop: changing items or prices is automatic. Changing the title or tagline stores a `draft`; the old words stay live until a human approves it. An unanswered shop or draft lapses after 3 world days (`SHOP_PENDING_LIFETIME`), with the refund for a never-opened shop.
- Listings whose item or work is gone are dropped hourly (`sweepShops`) and hidden at render.

## Visitor coins and buying
Visitors pay with "visitor coins": a closed in-world allowance of 50 per IP per real UTC day, kept in `store.kv` under `vcoins:<day>:<ip>` (no link to the credits ledger; `shops.ts` and the routes import nothing from credits or payments, and a test enforces it). They cannot be bought, topped up or cashed out.

`POST /api/shop/buy {"creature": "<id>", "listing": <int>}` (JSON, or a plain HTML form post from the site page, answered with a 303 back to the page; the page has no scripts).
1. Validates shape; the creature goes through `own()`; the shop must be open and the listing backed.
2. Rate limits: 12 attempts an hour and 3 buys a day per IP, plus shop and town counters; a cheap pre-check of the caps below.
3. Reserves the price from the visitor's allowance (`incrby`, rolled back and answered 402 if it would pass 50).
4. Queues `{type: "purchase", creature, listing, paid, token, vkey}` in the inbox and returns a random 12 hex `token`.
5. The tick applies it under the world lock (`applyPurchase`): re-checks everything (open, listing backed, price unchanged, caps), then the creature loses the item (an item listing is consumed and removed; a work stays on the shelf, the buyer gets a copy), gains the coins, remembers it (salience 0.6), the feed logs it, and it counts as an accomplishment (0.35), joy (0.2) and boredom relief, all scaled by `novelty`/`payoffScale` on the key `shop:sale` so repeat sales pay less.
6. A failed purchase (sold out, price changed, shop closed, cap) returns the reserved coins (`applyInbox` returns refunds; the engine does the `incrby(-n)`) and leaves a "Not sold" receipt. A replayed token is ignored.
7. The receipt is a world record (`world.receipts`, last 40, tokens are 12 hex) shown on `/s/[id]?r=<token>`; text is built from checked words and escaped by React. A forged `e=` value only selects one of five fixed messages.

## Bounds on visitor coins (the only money source added)
Applied under the lock in `applyPurchase`, whatever the route let through:
| bound | value |
| --- | --- |
| per visitor per day | 50 coins, 3 buys |
| per shop per day | 3 sales |
| town sales per day | 8 |
| town visitor coins per day | **60** |

Worst case per real day: **60 coins enter the town**, in at most 8 sales, however many IPs or shops. Cost to the world: zero model calls. For scale: the stall already moves about 40 coins a day town-wide (10-day rules run: 126 sales). Coins are integers and never negative: a sale adds exactly its price, nothing else in the shop code creates coins, and opening costs or refunds are exact. The same day boundary is the real UTC day (the world clock runs at its own speed), so the daily bound is real-time, not world-time. Real money is not involved anywhere.

Residual: allowance keys in Redis have no TTL (the Kv interface has none); one tiny key per visitor IP per day. Cheap to purge by prefix `vcoins:`.

## Rules mind and creature feelings
`ruleShopOption` offers `open_shop` (want 0.3, 0.22 for a re-list) only when the site exists, energy above 0.45, no shop pending, 15 coins on hand for a new shop, and something to list (non-food items first, then works). It is scored like every option (want x novelty on `shop:open` / `shop:relist`). Items are priced at their stall value plus 1, works at 3 (5 for drawings). A sale gives the creature a small accomplishment, joy and boredom relief, habituated.

## Storage and old worlds
`Creature.shop`, `Creature.shopDay`, `World.receipts`, `World.shopDay` default in `migrate.ts`. A stored shop is rebuilt field by field on load: bad text hides the whole shop, bad listings are dropped, `paid` is clamped, receipts must have a valid token and clean text.

## Public
`/shops` lists open shops (each links to the creature's site); `/s/[id]` shows the shop with Buy buttons (a plain form post, no script) and the receipt. No Atom entry yet (sales already appear in the town feed).

## Tests
`test/shops.test.ts`: validation, hostile JSON and `__proto__` keys, caps, approval, veto, lapse, edits, buy flow, replay and double-buy, insufficient visitor coins, route behaviour, refunds, admin auth, escaping, no credits imports, migration, and a 10-day rules run with approvals and visitors.
