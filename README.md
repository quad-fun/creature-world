# Creature World

Phase 1 of the Open Creature World spec: a small text-world town where three autonomous creatures
(Moss the otter, Pip the magpie, Bramble the toad) live on their own. Their needs and feelings are
computed by code; a cheap model, called through the **Vercel AI Gateway**, only chooses what to do next.
Everything it proposes is validated by the world before anything happens.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| World rules | `src/lib/sim.ts` | Authoritative. Validates and performs every move. Models cannot change state any other way. |
| Emotion | `src/lib/affect.ts` | Drives, valence/arousal, slow mood, bonds. Pure code. The model only sees words ("hungry, a bit lonely"). |
| Model mind | `src/lib/mind.ts` | AI SDK `generateText` + `Output.object`, plain `"creator/model"` string through the Gateway. |
| Rule fallback | `src/lib/rules.ts` | Free, instant. Used when the model is slow, errors, is over budget, or is disabled. |
| Tick engine | `src/lib/engine.ts` | Lazy time: each call works out how much world time passed, replays it with rules, and consults the model only for the present moment. |
| Storage | `src/lib/store.ts` | Upstash Redis on Vercel, in-memory locally. |
| Read API | `/api/world`, `/api/creatures/[id]` | Public, keyless, read only. |

Creatures sleep at the nests, wake and write a diary, and rewrite their own "what I know about myself"
note (locked lines in the sheet are never touched). Gifts, speech, crafting, selling at the stall and buying
bread (limited stock) create scarcity and bonds. Speech from others reaches the model wrapped as quoted
data, and a model can only emit moves from a fixed list.

## Run locally

```bash
npm install
cp .env.example .env.local      # add AI_GATEWAY_API_KEY, or set MIND=rules to run for free
npm run dev                     # http://localhost:3000
npm test                        # unit tests (no network)
npm run simulate -- 5           # five world days with rules only, prints behaviour
```

Without Gateway credentials the app runs on the rule fallback automatically.

## Deploy to Vercel

1. Push this folder to a GitHub repo, or run `npx vercel` from it.
2. In the Vercel project, add the **Upstash Redis** integration (Storage / Marketplace). It sets
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. **AI Gateway**: on Vercel, authentication is automatic. Make sure the Gateway has credits for your
   team. Locally use `AI_GATEWAY_API_KEY` or `vercel env pull`.
4. Optional env vars: `CREATURE_MODEL`, `DAILY_CALLS_PER_CREATURE`, `TIME_SCALE`, and `CRON_SECRET`
   (set any random string; Vercel Cron then sends it automatically and `/api/tick` requires it).
5. Deploy and open the URL. The page polls `/api/world`, and each poll moves the town forward when due.

`vercel.json` ships with a **daily** cron because Hobby projects are limited to daily schedules. The town
mostly lives while someone is watching, and catches up (up to one world day) when they return. On a Pro
plan change the schedule to something like `*/5 * * * *` to keep it ticking when nobody is looking.

## Choosing the model and cost

`CREATURE_MODEL` accepts any Gateway model id. Prices below are from the Gateway model list when this was
built; check the current list before relying on them.

| Model | Input / Output per 1M tokens |
| --- | --- |
| `anthropic/claude-haiku-5.5` (default) | $0.10 / $0.50 |
| `alibaba/qwen3.7-flash` | $0.03 / $0.13 |

A decision is roughly 1,200 input and 150 output tokens, so about $0.0002 per call at the default.
The hard cap `DAILY_CALLS_PER_CREATURE` (default 200) bounds spend at roughly $0.04 per creature per day.
The page footer shows calls, tokens and an estimated cost. After four consecutive model errors the model is
paused for ten minutes and creatures run on rules, so a bad key or empty credits cannot loop.

## What this is not yet

Per the spec roadmap this is Phase 1. Not built yet: visitor gifts and notes, accounts, hatching your own
creature, real-money credits or any crypto, 2D rendering, the open brain protocol. The soft coins here are
a game currency only. Visitor text will need the moderation and injection controls from the safety section of the
spec before it is allowed anywhere near a model.

Creatures are software with modelled feelings, not conscious beings, and the UI says so.
