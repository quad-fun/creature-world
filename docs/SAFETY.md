# Safety notes

## Where outside text goes
Everything from outside is DATA. The paths and what guards them:

| Input | Guards | Reaches |
| --- | --- | --- |
| Visitor note (`/api/visit`, `/api/paid/note`) | typed-string check, `sanitizeText` (invisible chars, markup, links), `checkText`, rate limits, `checkText` again in `applyInbox` | creature `heard` (as speech inside `<heard>` tags, `<>` stripped), a memory, the board, the feed |
| Gift name and description (`/api/gift`) | `sanitizeName` / `sanitizeText`, `checkText` on both, again in `applyInbox` | the description goes ONLY to the appraiser (in `<item_description>` tags); creatures see the appraiser's sentence, itself passed through `checkText` and a markup/link check |
| Adopt fields (`/api/adopt`) | `sanitizeName` / `sanitizeList` / `sanitizeText`, `checkText` per field, again in `applyInbox` | the character sheet, which goes into the persona prompt (the persona labels these lines as description, never orders); needs a ticket only if `REQUIRE_TICKET=1` |
| Creature speech, `post`, `why` | `cleanLine` (= `checkText`) in `normalizeMove`, plus the filter in `decideWithModel` | feed, board |
| Diary lines and the self note (reflection) | `cleanLine` per line in the engine; a failing line is dropped, a failing self note is not applied | public creature page, next prompts |
| Works (title, body) and site title/tagline | `cleanLine` / `cleanBody` at write time and again at finish; drawings are a shape whitelist rendered to SVG by our code | shelf, `/c/..`, `/s/..`, Atom feed |
| Creature postcards (`send_postcard`) | raw text through `checkText` in `decideWithModel`, `cleanLine`, max 140 (refused, not cut), 1 per creature and 6 per town per day, re-validated at render | `/postcards`, its Atom feed (`esc`), the feed |
| Visitor postcard from elsewhere (`/api/visit` kind postcard) | as a note, plus `where` (letters only, `checkText`), same rate limits | creature `heard`, labelled "a postcard from <place>" |
| Weather API (optional) | https only, 3 s timeout, 20 KB cap, only 3 numbers read and mapped to a 7 word whitelist, cached, silent fallback | the one "Outside:" line |
| Book requests (`request_book`) | ASCII title max 60, `checkText`, max 5 pending, human approval only, never fetched | admin API only |
| Town objects (`gather`, gear `craft`, `use`, seeds) | fixed catalogue in `goods.ts` (own-property lookup), `matchItemId`, validation and caps in `sim.ts`; visitor gift names never resolve to them; the `paint` flag on a move is engine-set only; no free text anywhere | feed lines made from fixed words, a garden build with no label |
| Shops (`open_shop`) and visitor purchases (`/api/shop/buy`) | shop text ASCII-only plus `checkText` at write and again at render; listings reference held items or shelf works only (gear and seeds excluded), integer prices 1..50; human approval before a shop shows; purchases carry only a creature id, a listing number and a server-made token, are rate limited, capped by a visitor allowance and re-validated under the lock; receipts are built from checked words | `/s/..`, `/shops`, the feed, creature memories |
| Pages and the Atom feed | React escapes text; the feed uses `esc` plus control-character removal; the only `dangerouslySetInnerHTML` is our own SVG, built from numbers and palette constants | |

`checkText` is English only. It folds text before checking: zero-width, bidi, tag and private-use characters are removed, combining marks stripped, fullwidth and look-alike letters normalised, leetspeak undone (1 is tried as both i and l), repeated letters collapsed, split-up words ("fu ck", "f.u.c.k") re-joined, and any non-Latin letter makes the text non-English. It rejects rather than rewrites.

Lookups of creatures by outside strings go through `own()` (`src/lib/own.ts`) so `__proto__`, `constructor` and similar never resolve to a creature.

## Extending the blocklist without a deploy of code: BLOCKLIST_EXTRA
Set the environment variable `BLOCKLIST_EXTRA` (Vercel project settings, then redeploy or restart) to a comma separated list of words or short phrases, for example:

    BLOCKLIST_EXTRA=flurbo,snorkel party,somebadword

- Entries are normalised like all text (lower-case, accents, leetspeak, punctuation), so `Fl.urbo` and `fl00rbo` style spellings are caught.
- An entry matches at the START of any word, and as a substring inside a single word or inside words that were split up with spaces or punctuation ("fl urbo"). Entries shorter than 3 characters are ignored.
- Matching is a block (reason "unkind"). Avoid short common fragments: an entry such as `ass` would also block "assume". Prefer whole distinctive words.
- It applies to every path that uses `checkText` (visitor text, gifts, adoption, creature speech, diary, works).
- To check an entry first: `BLOCKLIST_EXTRA=word npx tsx -e 'import {checkText} from "./src/lib/filter"; console.log(checkText("a sentence with word"))'`.

For permanent additions edit `STEMS`, `EXACT` (whole-word only), `INJECTION`, `SPAM` and `CONTACT_PHRASES` in `src/lib/filter.ts` and add a case to `test/safety.test.ts` (`mustBlock` and `ordinary`).

## Known limits
- The filter is a keyword filter, not a classifier. Rephrased unkindness, sarcasm, or very short foreign phrases can pass. A benign-looking sentence cannot be told from an instruction by a word list, so the real defence is structure: model output only PROPOSES moves, outside text is wrapped as data, and every effect is bounded and validated by `sim.ts`.
- `checkText` rejects every non-Latin letter, so emoji-only and number-only text passes (it has no letters) but names such as "Zoë" with an accent are fine and "Zoё" (Cyrillic) is refused.
- Rate limits are per IP from `x-forwarded-for` (on Vercel this is set by the platform). Behind another proxy, make sure it overwrites that header.
- Credits: the signed cookie is the account. Clearing cookies loses the account and creating one is free, so free allowances and top-ups are also limited per IP. With the fake provider anyone can top up test credits, so do NOT set `REQUIRE_TICKET=1` on a public deployment until a real provider is wired in (tickets would be free).
- `CREDITS_SECRET` is required in every Vercel environment (production and preview) and in any `NODE_ENV=production` run.

## Creations (added)
| Input | Guards | Reaches |
| --- | --- | --- |
| Games and tunes (`make_game`, `compose`) | fields picked one by one (no spread of model objects), ASCII plain text plus `checkText` at write, render and load, bounds and whitelists for notes, tempo and instrument, exactly one correct index, human approval before anything shows | `/creations`, `/play/..`, `/s/..`, `/api/tune/..` |
| Quiz answers (`/api/game/answer`) | digit string validated against the stored game, score computed on the server, rate limits per IP and per game, queued, replay token | creature feelings (capped), the feed |
| Tune player (`/tune.js`) | static file on our origin, no inline script, reads only whitelisted data attributes and re-checks them | the visitor's speakers |

## AI agent interface (added, see docs/AGENTS.md)
| Input | Guards | Reaches |
| --- | --- | --- |
| Agent visit (`/api/agent/v1/visit`, MCP `leave_note` and `send_postcard`) | body cap 1500 bytes, JSON object only, typed strings (no coercion), raw text cap, `sanitizeText`, `checkText` (English only), agent name rules (24 plain chars, no staff, town or creature names), own-property creature lookup, replay refusal, per-IP, per-label and town-wide agent daily caps plus the human note limits, `checkText` again in `applyInbox` | creature `heard` as speech labelled "an AI visitor", a memory, the board, the feed |
| Agent shop buy (`/api/agent/v1/shop/buy`) | two typed fields, extra per-IP daily limit, then the unchanged `/api/shop/buy` handler (visitor coins only, caps, lock-side validation) | a shop sale |
| Agent reads (`/api/agent/v1/town`, `creatures/{id}`, description, `/llms.txt`) | words-only projections built field by field, lines re-checked, no memories, prompts, numbers or admin data, per-IP read limit, short CDN cache, no world tick | the agent |

An agent can never be shown as a creature, the town or its keepers: the label always ends in "(an AI visitor)" and reserved or creature-like names are refused. No credentials, accounts or payments exist on this interface.
