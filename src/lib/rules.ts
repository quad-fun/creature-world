// Rule-based fallback mind. Free, instant, deterministic given the world seed.
// Used when the model is slow, unfunded, over budget, or disabled, so a creature never freezes.
import { clockOf, creaturesAt, pick } from "./sim";
import { BREAD_PRICE, ITEMS } from "./content";
import type { Creature, Move, PlaceId, World } from "./types";

const LINES: Record<Creature["species"], string[]> = {
  otter: ["Afternoon. Slow day.", "You look like you could use some tea.", "I fixed something. Nobody asked me to."],
  magpie: ["Hello hello! Seen anything shiny today?", "Guess what I heard by the fountain!", "Don't tell anyone, but I'm a bit bored!"],
  toad: ["Ah... hello.", "I have been thinking about mud... it is a fine subject.", "Do you ever... wonder where the pond goes at night?"],
};

export function ruleMoves(w: World, c: Creature): Move[] {
  const out: Move[] = [];
  const d = c.drives;
  const clk = clockOf(w.t);
  let at: PlaceId = c.place;
  const walk = (p: PlaceId, why: string) => {
    if (at !== p) {
      out.push({ do: "walk", place: p, why });
      at = p;
    }
  };
  const foodItem = c.inventory.find((i) => ITEMS[i].food > 0);
  const sellable = c.inventory.find((i) => ITEMS[i].sell > 0);

  if (d.energy < 0.25 || (clk.isNight && d.energy < 0.7)) {
    walk("nests", "I am worn out and it is time to sleep.");
    out.push({ do: "sleep", why: "I need rest." });
    return out;
  }

  if (d.food < 0.45) {
    if (foodItem) return [{ do: "eat", item: foodItem, why: "I am hungry and I have something to eat." }];
    if (c.coins >= BREAD_PRICE && w.bakeryStock > 0) {
      walk("bakery", "I am hungry; the bakery has bread.");
      out.push({ do: "buy_food", why: "Bread, please." });
      out.push({ do: "eat", item: "bread", why: "Eating it while it is warm." });
      return out;
    }
    if (sellable) {
      walk("fountain", "I need coins for food.");
      out.push({ do: "sell", item: sellable, why: "Selling to buy bread." });
      return out;
    }
    if (d.energy > 0.3) {
      walk("workshop", "I need something to sell so I can eat.");
      out.push({ do: "craft", why: "Making something to sell." });
      return out;
    }
  }

  if (d.social < 0.4) {
    const here = creaturesAt(w, at, c.id).filter((o) => o.activity?.kind !== "sleep");
    if (here.length) {
      const o = pick(w, here);
      return [{ do: "speak", target: o.id, text: pick(w, LINES[c.species]), why: `I am lonely and ${o.sheet.name} is here.` }];
    }
    const spots = Object.values(w.creatures)
      .filter((o) => o.id !== c.id && o.activity?.kind !== "sleep")
      .map((o) => o.place);
    if (spots.length) {
      walk(pick(w, spots), "I want some company.");
      return out;
    }
  }

  if (d.curiosity < 0.4) {
    walk(pick(w, ["park", "pond", "fountain"] as PlaceId[]), "I am bored; time for a wander.");
    out.push({ do: "play", why: "Something new to look at." });
    return out;
  }

  if (sellable && c.coins < 10) {
    walk("fountain", "I have something to sell.");
    out.push({ do: "sell", item: sellable, why: "Turning it into coins." });
    return out;
  }

  if (d.energy > 0.35) {
    walk("workshop", "I feel like making something.");
    out.push({ do: "craft", why: "Keeping my hands busy." });
    return out;
  }
  return [{ do: d.energy < 0.35 ? "rest" : "wait", why: "Taking it slowly." }];
}
