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
