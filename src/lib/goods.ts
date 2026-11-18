// Town objects beyond bread and tea: a FIXED catalogue (berries, fish, fishing rod, paper kite, paint set, seed packet,
// umbrella). Nothing here is invented by a model: ids come from this table, effects are small constants, and sim.ts
// validates and performs every move. Habituation uses novelty.ts like everything else. No model calls live here.
import type { Creature, ItemId, ItemKind, PlaceId, World } from "./types";

export interface GoodSpec {
  kind: ItemKind;
  mood: number; // push per use or meal before habituation (<= PUSH_MAX in items.ts)
  energy: number;
  durability: number; // uses before it wears out
  cap: number; // most that may exist at once in the whole town (held + being crafted)
  craftCost?: number; // coins to make it at the workshop
  buyPrice?: number; // coins at the bakery
  usePlace?: PlaceId; // where `use` works
}

/** The whole catalogue. An id that is not a key here is not a town object (own-property lookup only). */
export const GOODS: Record<string, GoodSpec> = {
  berries: { kind: "food", mood: 0.01, energy: 0, durability: 1, cap: 9 },
  fish: { kind: "food", mood: 0.04, energy: 0.02, durability: 1, cap: 8 },
  rod: { kind: "tool", mood: 0.06, energy: -0.01, durability: 6, cap: 3, craftCost: 3, usePlace: "pond" },
  kite: { kind: "toy", mood: 0.1, energy: 0.01, durability: 8, cap: 2, craftCost: 2, usePlace: "park" },
  paint: { kind: "art", mood: 0, energy: 0, durability: 5, cap: 2, craftCost: 3 },
  seeds: { kind: "curio", mood: 0, energy: 0, durability: 1, cap: 4, buyPrice: 2, usePlace: "park" },
  umbrella: { kind: "wearable", mood: 0, energy: 0, durability: 4, cap: 3, craftCost: 3 },
};
export const isGood = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(GOODS, id);
export const GEAR_IDS = ["rod", "kite", "paint", "umbrella"] as const;
export const isGear = (id: unknown): id is (typeof GEAR_IDS)[number] => typeof id === "string" && (GEAR_IDS as readonly string[]).includes(id);
/** Goods that `use` accepts (rod, kite, seeds). Paint and umbrella work by themselves; food is eaten. */
export const isUsableGood = (id: unknown): boolean => isGood(id) && !!GOODS[id as string].usePlace;

// ---- berries ----
export const BERRY_MAX = 6; // town-wide supply at the park and pond bushes
export const BERRY_REGROW_MIN = 90; // one portion regrows this often (world minutes)
export const GATHERS_PER_DAY = 3; // per creature per world day
export const GATHER_MINUTES = 20;
export const GATHER_PLACES: PlaceId[] = ["park", "pond"];
export const gathersToday = (w: World, c: Creature): number => (c.gathers.day === Math.floor(w.t / 1440) + 1 ? c.gathers.n : 0);

// ---- fishing ----
export const FISH_CHANCE = 0.4; // per cast, drawn from the world's seeded rng
export const FISH_MINUTES = 25;
export const KITE_MINUTES = 20;
export const KITE_WIND = 1.5; // wind boosts a kite use (item mood stays under PUSH_MAX: 0.1 * 1.5)
export const KITE_HABIT = 2; // a kite use counts as this many exposures: it palls fast
export const PLANT_MINUTES = 15;
export const SEED_PRICE = 2;
export const UMBRELLA_SHIELD = 0.3; // rain discomfort and mood penalties keep this share while carrying one

export const weatherNow = (w: World): string => w.outside?.weather ?? "clear";
export const isRaining = (w: World): boolean => weatherNow(w) === "rain";

/** How many of a good exist in the town: carried, or being crafted right now. */
export function existing(w: World, id: ItemId): number {
  let n = 0;
  for (const c of Object.values(w.creatures)) {
    n += c.inventory.filter((i) => i === id).length;
    if (c.activity?.kind === "craft" && c.activity.move.item === id) n++;
  }
  return n;
}
/** The town already has as many of this as it may. (Seeds in the ground count too.) */
export function capReached(w: World, id: ItemId): boolean {
  if (!isGood(id)) return false;
  return existing(w, id) + (id === "seeds" ? (w.plantings ?? []).length : 0) >= GOODS[id].cap;
}

export const hasUmbrella = (c: Creature) => c.inventory.includes("umbrella");
/** A rain penalty (comfort or mood), reduced when the creature carries an umbrella. Bounded: never negative, never larger. */
export const rainShield = (c: Creature, amount: number): number => (hasUmbrella(c) ? amount * UMBRELLA_SHIELD : amount);
