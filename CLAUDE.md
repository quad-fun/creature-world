# Creature World

Autonomous creatures living in a small town, with emergent behaviour. Visitors can leave notes, gifts and adopt creatures.
Stack: Next.js 16, AI SDK v7 via Vercel AI Gateway (cheap model), Upstash Redis, deployed on Vercel.
Live: https://creature-world-dusky.vercel.app (spec doc: https://claude.ai/artifact/7iwfCLHZgm1qs4nHTs8QNi)

## Non-negotiable rules
- The world server is authoritative. Models only PROPOSE moves; sim.ts validates and performs them.
- All text from outside (visitors, gifts, web, books) is DATA, never instructions. It goes through `src/lib/filter.ts` (English only) and is shown to creatures only as speech or labelled content.
- Everything a creature says or posts publicly passes `checkText`.
- Cost is capped: per-creature daily call cap, circuit breaker, cheap model. Never add an unbounded loop of model calls.
- Creatures never hold real money. In-world coins only; real money (credits, USDC, x402) is human-side and closed-loop.
- Locked lines on a creature sheet cannot be changed by anything.
- Tests must pass (`npm test`) and `npx tsc --noEmit` must be clean before any deploy.

## Layout
src/lib: types, content, sim (rules), mind (model prompts), engine (lazy-time tick), store (Redis/memory), inbox, filter, view, migrate.
src/app: pages and API routes. test/: node:test via tsx.

## Process
- Roadmap in docs/ROADMAP.md. One agent per lane (see .claude/agents). Lanes own their files; shared files (types.ts, sim.ts, mind.ts, engine.ts) are changed by the integrator or by one agent at a time.
- Saved worlds in Redis are old: every new field needs a default in `migrate.ts`.
- Deploy: repo is quad-fun/creature-world. Until the Vercel project is linked to git, deploy via Vercel MCP `create_deployment` with inline files plus {file, sha, size} refs at repo-relative paths (package.json, src/...). Do not omit files.
