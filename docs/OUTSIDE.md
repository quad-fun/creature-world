# Outside: weather, books, postcards

Everything from outside is DATA. It is reduced to a whitelist, length-capped, filtered with `checkText` (English only), labelled, and shown to creatures only as labelled content or speech. The server fetches; the model never browses. No new model calls: every move below is part of the normal decision and uses the same per-creature daily cap (see COSTS.md).

## 1. Weather and calendar (`src/lib/outside.ts`)
- `World.outside`: `{date, weather, season, holiday, source, by, appliedDay}`. Weather is one of `clear, rain, snow, wind, hot, cold, fog`; season from the date; holiday from a fixed list in the file (New Year's Day, Spring Day, Midsummer, Harvest Day, Lantern Night, Midwinter, the Winter Festival). No holiday label ever comes from the network.
- Default provider: a deterministic seeded fake (hash of date and a 6-hour block, weighted by season). Tests and offline runs use it. Sims without the engine get `worldOutside` (day 1 = 2026-01-01).
- Optional live reading: set `WEATHER_URL` (https only), `WEATHER_LAT`, `WEATHER_LON`. The call is a GET to Open-Meteo style `?latitude&longitude&current=temperature_2m,weather_code,wind_speed_10m`. Only three numbers are read (WMO code, deg C, km/h) and mapped to the whitelist; no text from the response is kept. Bounds: 3 s timeout, redirects refused, 20 KB body cap, cached 1 h in the store (`outside:weather`), after a failure no retry for 10 min (`outside:fail`), any failure falls back silently to the seeded fake. The engine calls it under the world lock, at most about once an hour.
- Effect: once per world day `applyOutside` gives small nudges through existing influences (joy outdoors on a clear or snowy day, comfort discomfort when raining or cold or hot outdoors, boredom relief on a windy day, fog joy at the pond, holiday loneliness relief and fountain joy), scaled by `payoffScale(novelty(...))` with key `weather:<cond>` so the same weather pays less each time.
- Shown as one line ("Outside: cold, winter, Midwinter") in the town view (`publicView.outside`) and in the decision prompt as a labelled fact.

## 2. Books (`src/lib/books.ts`)
- A fixed shelf of 8 public-domain titles: id, title, author, an original ~300 character summary (no quotes, no copied text), and up to 2 tags that are existing interest topics. The creature sees this catalogue in the prompt as labelled facts.
- Move `read_book` (`item` = book id; unknown ids, `__proto__` and the like never match). Needs energy of at least 0.2, costs 0.04 energy and 30 world minutes, at most 2 a day per creature. Effects: boredom relief and joy scaled by novelty (rereading pays less), one small interest nudge per tag (`exposeInterest`, bounded by MAX_INTERESTS), a memory and a feed line. The existing reflection (model or rules) turns the memory into a diary line; there is no extra call.
- Move `request_book` (`title`): plain ASCII letters/digits/light punctuation, max 60, `checkText`, not already on the shelf or requested. Goes to a human queue: at most 5 pending, 12 kept, one per creature per 3 world days, pending lapses after a world week. Titles only; nothing is ever fetched. Admin: `/api/admin/books` (same `ADMIN_SECRET` gate, constant-time compare and 60/min rate limit as builds): `GET` lists, `POST {action: "approve"|"reject", id}` under the world lock. Approve only marks the request; a human adds the book to `BOOKS` with an original summary.

## 3. Postcards out (`src/lib/postcards.ts`)
- Move `send_postcard` (`text`). One line, at most 140 characters (longer is refused, not cut), `checkText` (also applied to the raw model text in `decideWithModel`), 1 per creature per world day, 6 per town per world day. Stored in `World.postcards` (last 40).
- Public page `/postcards` and Atom feed `/postcards/feed.xml`. Every value goes through `esc` plus control character removal. Stored cards are re-validated at render (anything that the cleaner would alter is not shown).
- Outgoing only: no address, recipient, email or mail of any kind. Creatures cannot receive replies through this.
- Visitor "postcard from elsewhere": the `/api/visit` route accepts `kind: "postcard"` with `where` (a place name, letters only, max 24) and `text`. Same sanitising, `checkText` on text, name and place, same rate limits as notes (6/h per IP, 80/day town-wide), applied through the inbox and shown to the creature as labelled speech from "Name (a postcard from Place)". A small form field and button are on the town page.

## Storage and old worlds
`outside`, `postcards`, `postcardSeq`, `bookRequests`, `bookSeq` on the world and `reads`, `cards`, `booksRead`, `bookReqDay` on creatures all have defaults and validation in `migrate.ts`. Stored postcards, requests and `outside` that do not match the schema are dropped on load.

## Tests
`test/outside.test.ts`: filter application, caps, hostile model output, weather fallback and cache, mapping, migration, feed escaping, admin gate, visitor postcards.

## Future work (not built)
Real email and a physical kiosk. Safety design if they are built:
- Outbound email: only to an owner-approved allowlist of addresses set in env, never an address chosen by a creature or a visitor. Each message is drafted by a creature, passes `checkText`, then waits in a human approval queue (`ADMIN_SECRET`) and is sent by the server only after approval. Hard daily cap. Credentials live only in server env, are never in the world state or a prompt, and a send failure is dropped silently. No inbound mail is parsed as instructions; if inbound is ever added it is just another visitor note through the same filter and rate limits.
- Kiosk: a read-only display of the public view and postcards; any input goes through `/api/visit` with the same limits. No credentials, no remote control, no write path to the world other than the inbox.
