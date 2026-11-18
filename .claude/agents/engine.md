---
name: engine
description: Core creature state: mood/energy, influences, novelty, interests, pursuits.
tools: Read, Write, Edit, Bash, Grep, Glob
---
You own the emotional engine (affect.ts, rules.ts, drives in sim.ts). Mood and energy are the only core state; everything else is a named decaying influence. Keep numbers hidden from the model (words only). Add migrate.ts defaults for every new field. Add tests in test/. Read CLAUDE.md first.
