# Items: the fixed town catalogue (batch 1)

Seven town objects in addition to bread, tea and the three crafted goods. They are a FIXED catalogue: ids live in `ITEMS` (content.ts) and rules in `GOODS` (`src/lib/goods.ts`). A model can only propose moves; `sim.ts` validates and performs them. Nothing the model says can create an object that is not in the table (`isGood` uses own-property lookup, so `__proto__` and friends never match). No new model calls; no loops.

| id | name | how you get it | what it does | bound |
| --- | --- | --- | --- | --- |
| berries | berries | `gather` at the park or pond (free) | food 0.15 (bread is 0.5), tiny mood | 3 gathers per creature per world day; town supply 6, regrows 1 per 90 world minutes; cap 9 in the town |
| fish | fish | chance when using a rod at the pond | food 0.65 (better than bread), mood 0.04, sells for 2 at the stall | cap 8; sells and gifts like any food; habituation on `item:fish` |
| rod | fishing rod | `craft` at the workshop, 3 coins | `use` at the pond (25 min): calm mood lift 0.06, comfort relief, 40 percent chance (world seeded rng) of one fish if there is room in the hands | wears out after 6 uses; cap 3; one per creature; not sellable |
| kite | paper kite | `craft`, 2 coins | `use` at the park (20 min): joy 0.10; wind weather x1.5 (still <= 0.15, the item mood ceiling); rain blocks it (also if rain starts mid-flight: no effect, no wear) | counts as two exposures per use, so it palls fast; wears out after 8; cap 2; not sellable |
| paint | paint set | `craft`, 3 coins | automatic: a `make` of kind drawing while carried costs 1 coin instead of 3 and adds a small accomplishment bonus. Same whitelist drawings and rendering as the library (no new rendering) | wears out after 5 drawings; cap 2; not sellable; the `paint` flag on a move is engine-set only, never read from model output |
| seeds | seed packet | `buy_food` item "seeds" at the bakery, 2 coins | `use` at the park plants it. After one world day (checked hourly) it becomes an auto-approved, unlabelled garden build through the builder lane | planting counts toward the per-place cap (3) and town cap (12) from the moment it is planted, so a ripe packet always has room; at most 4 growing; cap 4 including those in the ground; one packet per creature |
| umbrella | umbrella | `craft`, 3 coins | automatic while carried: rain discomfort (comfort need bump) and the rain mood penalty keep 30 percent of their size | wears one use per rainy day spent outdoors (durability 4); cap 3; not sellable |

All gear (rod, kite, paint, umbrella) costs more to make than it could ever sell for (it cannot be sold at all), so there is no craft-and-sell arbitrage. Only fish sells (2 coins, same saturation/floor/stall-run rules as everything else). The existing `MAX_CARRY` (6) applies to everything: a gather, craft or catch never overfills hands (a finished craft with no room returns its materials; a rod cast needs a free hand).

## Where each is validated (sim.ts)
- `craft` with `item` rod/kite/paint/umbrella: workshop, coins, one per creature, town cap (including crafts in progress, `existing()` in goods.ts). Any other `item` is ignored and the move is the species craft.
- `buy_food` with `item` "seeds".
- `gather`: new move kind. Park or pond only, energy, hands, per-day limit, supply.
- `use` of rod, kite or seeds: `goodUseError` (place, energy, rain for kites, caps for seeds). A wrong place auto-walks to the right one (`destFor`), like sell/buy/craft. Paint and umbrella are refused with an explanation; berries and fish are eaten.
- Gifts: a creature that already holds a gear item cannot be given another.
- Visitor gifts never resolve to a town object (`matchItemId(..., {goods:false})`): a gifted "Kite" is an appraised custom toy, so caps cannot be bypassed.

## Rules mind
After urgent needs, free-time options are scored by want x novelty like everything else: gather berries (more wanted when hungry, and a hungry creature with nothing else gathers before crafting), fish, fly a kite (more in wind, never in rain), plant seeds, buy seeds, craft a missing piece of gear (umbrella more in rain), draw with paint. A snack from the pocket is eaten when somewhat hungry. Everything keeps a 10 coin reserve for bread.

## Prompt
The decision prompt lists the fixed catalogue with where each is usable, the weather note for kites, and says again that only listed things exist (the model is told not to invent or ask for others). The `gather` move and the new `item` choices are in the move list.

## Storage and old worlds
`World.berries`, `World.plantings` and `Creature.gathers` have defaults and validation in `migrate.ts` (plantings must be at the park, with a ripening time within two days; at most 4). Saved inventories with new ids resolve through `itemDef`; unknown ids still fall back to a harmless curio.

## Measured effect (scripts/metrics.ts, 10 world days, rules mind)
Before (main) vs after, same seed: distinct activities per creature-day 9.55 vs 10.00; market floors mended-thing 4, trinket 3, potion 5 (before) vs 4, 3, 4 (plus fish 2); sell:craft 0.96/1.15/0.85 vs 0.86/0.95/0.80 (moss/pip/bramble; gear crafts count as crafts); starvation events 0 vs 0 (max hunger 0.74 vs 0.77); final coins 50/13/46 vs 24/8/54 (gear is paid for in coins); peak items per creature 6 vs 6. Item counts over 10 days: gather 10, berries eaten 10, kite uses 23, rod uses 7 (2 fish eaten, 2 sold), seeds bought 5 and planted 4, paint-assisted drawings 30, crafted rod 4, kite 4, paint 7, umbrella 3. Peak held at once in the town: kite 2, umbrella 3, paint 2, rod 3, seeds 2, fish 1, berries 1 (all within caps). The script prints item and activity counts per kind and peak held per object.

## Tests
`test/items2.test.ts`: catalogue and name matching, visitor gifts cannot bypass caps, each item's effect, supply and per-day limits, wear-out, habituation, rain and wind, caps (including crafts in progress and seeds in the ground), builder cap interaction, prompt content, hostile model output, migration, and a 6-day rules run that checks caps, variety and no starvation.
