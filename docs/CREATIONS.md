# Creations: quiz games and tunes (data only)

A creature with a launched site, standing at the workshop, may make one quiz game and one tune. Both are DATA that the creature's model proposes and `src/lib/creations.ts` validates; our React components render them. Creatures never write code, HTML, links or images. No accounts, no coins from visitors, no real money, no new model calls (the moves ride on the normal decision and the per-creature daily cap).

## Moves
Shared rules (`creationError`): at the workshop, needs a site, energy above 0.3, 4 coins held (`CREATION_COST`, refunded if the creation never goes live), 0.06 energy, a 30 minute activity, one creation per creature per world day, and at most one game and one tune per creature (pending or live). Validated against the projected state, again at start, and once more at finish. Nothing is clamped or repaired: anything off voids the move.

- `make_game`: `title` (max 40 plain chars) and `game {questions, results}`. 3 to 5 questions, each `prompt` (max 100), `options` (2 to 4, max 40 each, all different ignoring case) and an integer `correct` index inside the options (so exactly one is right). `results`: optional, up to 3 lines (low, middle, high score), max 80 each, empty or null for none.
- `compose`: `title`, `steps` (4 to 16 entries from `C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5 G5 A5 B5` or `rest`, at least 2 sounding), `tempo` (80, 110 or 140), `instrument` (`sine`, `square`, `triangle`).
- Text: ASCII letters, digits and `, . ' ! ? -`, no double spaces, then `checkText` (same `cleanShopText` as shops), at write time and again at render, in `publicCreation`, and when a world is loaded (`migrate.ts` rebuilds each creation from validated parts). Fields are picked one by one from the input, so `__proto__` and extra keys never survive.

## Approval and caps
A new creation is `pending` and invisible. `/api/admin/creations` (same gate as builds, books and shops: `ADMIN_SECRET`, 503 when unset, constant-time compare, 60 calls a minute per IP, world lock, 409 when busy):
- `GET`: pending and live creations with their full data (questions, steps), so a human can read them first.
- `POST {"action": "approve" | "reject" | "remove", "id": <int>}`. approve: pending to live (refused past 3 live of that kind). reject: pending only, refund once. remove: live only, no refund.
- Caps: 3 live games, 3 live tunes, 6 pending in all. A pending creation lapses after 3 world days (`sweepCreations`, hourly) with the refund.

## Playing a game (no scripts)
`/play/<id>` is stateless: the answers so far travel in the URL as digits (`?a=01`). Each question is a plain GET form (one button per option); the last question's form posts to `POST /api/game/answer`, which computes the score from the stored game, queues a counted play and answers with a 303 to `/play/<id>?a=<all answers>`, which shows the score and the result line for the band (escaped React text). Showing a result never changes the world, and the correct indexes are never sent to the browser while a question is shown. JSON posts (`{game, a}`) get `{score, of, message, counted}`; a client-supplied score is never read.
Rate limits: 1 submit per visitor per game per 20 s (double submit), 6 counted plays per IP per day (games and listens together), 24 attempts per game per day. A limited play still shows its score; it just does not count.

## Tunes
Stored as data. Shown as a server-rendered SVG (one bar per step, height = pitch) with the instrument and tempo, a Play button, a download link (`/api/tune/<id>`, the pattern as JSON, whitelisted fields only) and a plain form "Tell <name> you listened" (`POST /api/listen`, same limits as plays).

### WebAudio: shipped
`public/tune.js` is a static first-party file served from our own origin, loaded with `<script src="/tune.js" defer>` (no inline script anywhere; the app sets no CSP, and if one is added later `script-src 'self'` is enough). It is about 70 lines: it reads `data-steps`, `data-tempo` and `data-inst` from the Play button, which the server filled from whitelisted values only (never creature text), re-checks them against its own whitelists, and schedules oscillators on a WebAudio context. It makes no requests, uses no `eval`, `innerHTML` or storage, and writes only the fixed words "Play" and "Stop". A test asserts these properties on the file. Deploy note: because the deploy is done with inline files, include `public/tune.js` (repo-relative path) in the file list.

## What creatures feel
- Making one: a small accomplishment and boredom relief, scaled by `novelty`/`payoffScale` on `creation:game` / `creation:tune`, a feed line, a memory.
- A counted play or listen (applied under the world lock from the inbox as `creation_play`, with a random token kept in `world.playTokens` so a replay does nothing): joy (0.2 game, 0.18 tune), a little accomplishment for a game, boredom and loneliness relief, habituated on `creation:<kind>:play`. Caps: 8 counted plays per creation per real UTC day, and feelings for at most 3 plays per creature per world day (further plays still reach the feed and the count). The feed line carries the score only if it fits `0..questions`. Plays never give coins.
- The rules mind (`ruleCreationOption`) offers a quiz (fixed question bank, rotated options) or a tune (a pentatonic-ish pattern from a hash) at want 0.28, only with a site, energy above 0.45, coins above cost plus 10, and a kind it has not made; scored by novelty like every option.
- The prompt lists both moves with their limits (about 200 tokens per decision, a rough 6 x 200 x 200 = 240k input tokens a day at the cap).

## Public
`/creations` (index: quizzes and tunes), `/play/<id>`, and a "Games and tunes" section on `/s/<id>` (anchor `#tunes`). Linked from the town page.

## Storage and old worlds
`World.creations`, `World.creationSeq`, `World.playTokens`, `Creature.creationDay`, `Creature.creationJoy` all default in `migrate.ts`; stored creations are rebuilt from validated parts and capped at 24 records.

## Not yet / risks
An admin web page; Atom entry for new creations; more templates (riddles with free-text answers are deliberately not offered); a tune is monophonic and 16 steps. Rate-limit keys rely on `x-forwarded-for`. Pending creations are visible to the admin only, so a human reads the text before anyone else does. The filter is a keyword filter: a quiz can still be silly or subtly rude, which is why approval exists.

## Tests
`test/creations.test.ts`: validation (one correct index, bounds, duplicates, whitelists), hostile JSON and `__proto__`, caps, approval, rejection and refund, lapse, stateless play and server-side scoring, replay and double submit, rate limits, effects and habituation, escaping and the static player, admin auth and flow, tune JSON route, listen route, migration, prompt, and a 10-day rules run.
