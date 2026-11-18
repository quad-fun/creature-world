# Builder: guarded world-building

A creature may propose a small addition to the place it is standing in (move `propose_build`). The model only proposes; `src/lib/builder.ts` and `sim.ts` validate and perform it. A build is data: a kind from a fixed catalog, a place id, and optionally one short label. It adds no mechanics, code or HTML.

## Catalog (`BUILD_CATALOG`)
| kind | cost (coins) | approval | effect when noticed (before habituation) |
| --- | --- | --- | --- |
| bench | 4 | auto | comfort relief 0.08, joy 0.06 |
| garden | 5 | auto | comfort 0.03, joy 0.14 |
| flowerbox | 2 | auto | comfort 0.02, joy 0.10 |
| lantern | 3 | auto | comfort 0.04, joy 0.08 |
| sign | 3 | human only (needs text) | joy 0.08 |

Anything not in the catalog is refused. `isBuildKind` uses own-property lookup, so `__proto__` and friends never match.

## Validation (all in code)
- `build` in the catalog; `place` must be the creature's current place (no building remotely; an unknown place voids the move rather than defaulting).
- Optional `text` (the label): max 40 characters, ASCII letters, digits, space and `, . ' ! ?` - `-` only, no double spaces, then `checkText`. The shared `cleanLine` runs first in `normalizeMove`, and a label that fails voids the whole proposal (it is not quietly dropped to make an unlabelled build). In model mode `decideWithModel` also drops a `propose_build` whose raw text fails `checkText`.
- Energy above 0.3, enough coins, one proposal per creature per world day (`BUILDS_PER_DAY`), at most 3 builds (active or pending) per place.
- Town caps: 12 active (`MAX_ACTIVE_BUILDS`), 6 pending (`MAX_PENDING_BUILDS`). A full town refuses further proposals; approving past the cap is refused.
- Cost: coins at the start (held while pending), 0.06 energy, a 30-minute activity.
- `propose_build` is validated twice: against the projected state (so `walk` then `propose_build` chains work) and again against the real state in `startMove`.
- No new model calls. The move is part of the normal decision and uses the same per-creature daily cap. The rules mind proposes only cheap text-free auto kinds, and never from the last 10 coins.

## Approval
- Auto-approved only when the kind has `auto: true`, there is NO label, and the cost is at most 5. It stands at once.
- Everything else starts `pending` and is invisible to the public until a human approves it.
- A pending proposal lapses after 3 world days (`PENDING_LIFETIME`) and is refunded.

## Admin API
`/api/admin/builds`, protected by the `ADMIN_SECRET` env var. Unset or empty: 503 (never open). Send `Authorization: Bearer <secret>` or `x-admin-secret`. Comparison is constant time (both sides SHA-256 hashed, then `timingSafeEqual`). Wrong secret: 401. Rate limited to 60 calls a minute per IP.
- `GET`: pending and active builds.
- `POST {"action": "approve" | "reject" | "remove", "id": <int>}`. It takes the world lock (409 "busy, retry" if a tick holds it), so it cannot race the tick engine.
  - approve: pending -> active (refused if 12 are active).
  - reject: pending only; deletes the proposal and refunds its coins in full, once (the record is deleted in the same step).
  - remove: active only; deletes it, refunds nothing.

Refund rule in one line: only a proposal that never stood (rejected or lapsed while pending) is refunded, at most its cost, once. A build that stood and then was removed or weathered away is never refunded. Refunds cannot exceed what was paid, and paying is limited to one proposal per creature per day, so coins stay bounded.

## Decay
An active build weathers away after one world week (`BUILD_LIFETIME`). `sweepBuilds` runs hourly in `stepWorld`. Together with the caps this bounds the town: at most 18 build records ever exist.

## Effects on creatures
When a creature arrives at a place, rests, or plays there, `noticeBuilds` applies up to 2 builds there: a small comfort relief and a joy influence, scaled by `payoffScale(novelty(...))` with the key `build:<id>` (reusing `novelty.ts`; repeated noticing pays down to 25 percent). A creature's own build pays half. The prompt lists builds at the creature's place as labelled facts, with `<>` stripped.

## Display
`publicView` lists active builds (`builds`) and the pending count. `town.tsx` shows them under the place as React text (escaped); there is no raw HTML anywhere.

## Storage and old worlds
`World.builds`, `World.buildSeq`, `Creature.buildsMade` all default in `migrate.ts`. On load every stored build is re-validated against the schema (kind, place, status, cost, label); anything else is dropped, and the list is clamped to 18.

## Tests
`test/builder.test.ts`: validation, hostile model output, caps, daily limit, veto and refund rules, decay, habituation, migration, admin auth and flow, and a 15-day rules run.
