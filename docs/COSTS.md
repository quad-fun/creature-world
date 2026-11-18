# Model cost and call bounds

Every model call in the app is one of four kinds. All go through `src/lib/engine.ts` (decisions, reflection and `make` writing) or `src/lib/appraise.ts` (gift appraisal). Nothing else calls the model, and no loop is unbounded.

| Kind | Where | Counted against | Bound |
| --- | --- | --- | --- |
| Decision | `think()` in engine | that creature's daily cap | `DAILY_CALLS_PER_CREATURE` (default 200) |
| Catch-up decision | `catchUpThink()` in engine, once before stepping a catch-up of 12+ steps | same creature cap | at most 1 per creature per tick (see below) |
| Reflection (on waking) | `think()` | same creature cap | same |
| Writing a piece (`make`) | `prepareMakes` | same creature cap, and `modelOk()` is re-checked first | at most one per decision, `MAKES_PER_DAY` = 2 per creature per world day |
| Gift appraisal | `appraiseGifts` | town-wide `APPRAISALS_PER_DAY` (default 6) | also at most 2 per tick, 10 gifts a day town-wide at the route, one per NEW item name (cached in the registry) |

Other guards:
- Circuit breaker: 4 consecutive thrown errors pause all model use for 10 minutes. (A reply that parses but holds no valid move is counted as an error but not as a consecutive one, so it is bounded only by the daily cap.)
- Catch-up and the model: the step loop itself never calls the model (`i < steps - 1` uses rules). Instead, when a tick catches up at least `CATCHUP_MIN_STEPS` (12, one world hour) steps, `catchUpThink` makes AT MOST ONE decision call per creature, in parallel, BEFORE the loop, to set a fresh goal (kept by the rules mind through `goalBonus`) and, for an idle creature, its first move (make/launch_site moves are dropped so no second writing call can follow). It is not in a loop and cannot repeat within a tick. It counts against the creature's daily cap, is skipped when the breaker is open or the cap is spent, and may only START in the first half of `MODEL_WINDOW_MS` (12.5 s after the tick took the lock). Present-moment calls then start only before 25 s, as before, so the worst case stays about 45 s from the lock.
- Worst case added by this: 1 call per creature per tick, i.e. at most 6 more billed calls (12 requests with retries) per tick; ticks are at least `MIN_TICK_INTERVAL_S` (20 s) apart, but every call still counts against the 200 per creature per day, so the daily ceiling above does not change.
- `maxSteps` = 288 per call, so a long absence is one day of rules-only catch-up plus the single catch-up decision above.
- `MIND=rules` or no gateway credentials means zero model calls.
- Time: no NEW model call starts more than `MODEL_WINDOW_MS` (25 s) into a locked tick; each call has a 20 s abort signal (appraisal 10 s), so a tick ends in about 45 s worst case, inside the 55 s lock TTL and the 60 s function limit. The inbox drain takes at most 50 items per tick.
- Visitor traffic cannot raise the model-call count: notes, gifts and adoptions are rate limited at the route and only enter the world through the inbox, and the per-creature cap is applied whatever triggers the tick.

## Worst case per day

Town size is at most `MAX_CREATURES` = 6.

- Creature calls: 6 creatures x 200 = **1,200 calls/day** (decisions + reflections + writing share the cap).
- Appraisals: **6 calls/day**.
- Total: **1,206 billed calls/day**. The SDK is set to `maxRetries: 1` for decisions, reflection and writing, so a flaky gateway can bill up to twice per call: **at most about 2,400 requests/day**. (Appraisal uses `maxRetries: 0`.)

Cost = calls x (input tokens x price_in + output tokens x price_out). Token estimates from the prompt builders: decision about 1,500 to 2,500 in and up to 500 out (`maxOutputTokens`); reflection about 600 in and 500 out; writing about 400 in and 700 out; appraisal about 300 in and 200 out. Use 2,500 in and 500 out as a pessimistic figure for every call.

The dashboard uses `MODEL_PRICE_IN` / `MODEL_PRICE_OUT` (USD per million tokens; defaults 0.1 and 0.5, which are placeholders: set them to the real prices of `CREATURE_MODEL`).

| Prices (in / out per M tokens) | 1,206 calls | 2,400 requests (all retried) |
| --- | --- | --- |
| 0.1 / 0.5 (defaults) | 1,206 x (250 + 250) / 1e6 = **$0.60** | **$1.20** |
| 1 / 5 (10x) | **$6.03** | **$12.00** |

A realistic day is far lower: creatures only decide when idle, sleep through the night and the engine only ticks while someone is watching (the cron runs once a day), but the figures above are what the caps allow. To lower the ceiling: reduce `DAILY_CALLS_PER_CREATURE`, `APPRAISALS_PER_DAY`, or set `MIND=rules`. `estCostUsd` on `/api/world` shows spend so far from actual token counts.

## Not model cost, but worth knowing
- `extra_daily_calls` is sold as a credits ticket but nothing redeems it yet. When it is wired in it must raise one creature's cap by a fixed, small number and still be bounded (no unlimited purchases per day).
- Redis: each page view, API read and visitor post does a full-world `GET`; rate-limit counters add one `INCR` per call. This is request volume, not model spend.
