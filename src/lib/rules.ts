// Rule-based fallback mind. Free, instant, deterministic given the world seed.
// Used when the model is slow, unfunded, over budget, or disabled, so a creature never freezes.
// It uses the same novelty/interest/pursuit logic as the world: after urgent needs, each option is
// scored by how much the creature wants it times how fresh it is, so non-model moments vary too.
import { needLevel } from "./affect";
import { BREAD_PRICE, SPECIES } from "./content";
import { familiarity, interestStrength, noteExposure, novelty, payoffScale, stepKindFor, topicOf } from "./novelty";
import { itemDef } from "./items";
import { ruleBuildOption } from "./builder";
import { ruleReadOption } from "./books";
import { cardLines, cardsToday, checkPostcardMove } from "./postcards";
import { ruleLibraryOptions } from "./library";
import { MAX_CARRY, usable, clockOf, creaturesAt, giftBlocked, pick, rand } from "./sim";
import type { Creature, ItemId, Move, MoveKind, PlaceId, World } from "./types";

const LINES: Record<Creature["species"], string[]> = {
  otter: ["Afternoon. Slow day.", "You look like you could use some tea.", "I fixed something. Nobody asked me to.", "The workshop smells of oil and rain today.", "Mind the loose plank by the pond."],
  magpie: ["Hello hello! Seen anything shiny today?", "Guess what I heard by the fountain!", "Don't tell anyone, but I'm a bit bored!", "I traded a button for a story. Good deal!", "Have you noticed how the fountain sparkles at noon?"],
  toad: ["Ah... hello.", "I have been thinking about mud... it is a fine subject.", "Do you ever... wonder where the pond goes at night?", "The reeds were unusually talkative this morning...", "I made something... it may be a remedy, or a mistake."],
};

const PLAY_PLACES: PlaceId[] = ["park", "pond", "fountain"];

interface Plan {
  score: number;
  moves: Move[];
}

export function ruleMoves(w: World, c: Creature): Move[] {
  const clk = clockOf(w.t);
  const hunger = needLevel(c, "hunger");
  const lonely = needLevel(c, "loneliness");
  const bored = needLevel(c, "boredom");
  const food = c.inventory.find((i) => itemDef(w, i).food > 0);
  const sellables = c.inventory.filter((i) => itemDef(w, i).sell > 0);
  const craftItem = SPECIES[c.species].craft;
  const awakeHere = creaturesAt(w, c.place, c.id).filter((o) => o.activity?.kind !== "sleep");

  const walkTo = (from: PlaceId, p: PlaceId, why: string): Move[] => (from === p ? [] : [{ do: "walk", place: p, why }]);

  const eatPlan = (): Move[] | null => {
    if (food) return [{ do: "eat", item: food, why: "I am hungry and I have something to eat." }];
    if (c.coins >= BREAD_PRICE && w.bakeryStock > 0)
      return [...walkTo(c.place, "bakery", "I am hungry; the bakery has bread."), { do: "buy_food", why: "Bread, please." }, { do: "eat", item: "bread", why: "Eating it while it is warm." }];
    if (sellables.length) return [...walkTo(c.place, "fountain", "I need coins for food."), { do: "sell", item: sellables[0], why: "Selling to buy bread." }];
    if (c.energy > 0.2 && c.inventory.length < MAX_CARRY)
      return [...walkTo(c.place, "workshop", "I need something to sell so I can eat."), { do: "craft", why: "Making something to sell." }];
    return null;
  };

  // 1. a body that is starving comes before everything
  if (hunger > 0.8) {
    const m = eatPlan();
    if (m) return m;
  }
  // 2. sleep
  if (c.energy < 0.25 || (clk.isNight && c.energy < 0.7)) {
    return [...walkTo(c.place, "nests", "I am worn out and it is time to sleep."), { do: "sleep", why: "I need rest." }];
  }
  // 3. hungry
  if (hunger > 0.55) {
    const m = eatPlan();
    if (m) return m;
  }

  // 4. free time: score each option by want x freshness, pick the best
  const plans: Plan[] = [];
  const add = (kind: MoveKind, want: number, moves: Move[], key?: string, topicBonus = 0) => {
    const nov = key ? novelty(c, key, w.t) : 1;
    const walkPenalty = moves.some((m) => m.do === "walk") ? 0.05 : 0;
    plans.push({ score: want * payoffScale(nov) + topicBonus - walkPenalty + rand(w) * 0.08, moves });
    void kind;
  };
  const pursuit = c.pursuit;
  const pursuitBonus = (kind: MoveKind, topic?: string) => (pursuit && topic === pursuit.topic && stepKindFor(pursuit.topic) === kind ? 0.35 : 0);

  if (sellables.length) {
    const want = Math.min(0.95, 0.3 * sellables.length + (c.coins < 8 ? 0.25 : 0));
    add("sell", want, [...walkTo(c.place, "fountain", "I have things to sell."), { do: "sell", item: sellables[0], why: "Turning it into coins." }]);
  }

  if (c.energy > 0.35 && c.inventory.length < MAX_CARRY) {
    const topic = topicOf("craft", "workshop", craftItem);
    const want = 0.5 - 0.12 * sellables.length;
    add("craft", want, [...walkTo(c.place, "workshop", "I feel like making something."), { do: "craft", why: "Keeping my hands busy." }], `craft:${craftItem}`, (topic ? interestStrength(c, topic) * 0.3 : 0) + pursuitBonus("craft", topic));
  }

  // something unusual to play with, if carried: new things are worth more
  const toy = c.inventory.find((i) => usable(w, i));
  if (toy) {
    const others = awakeHere.filter((o) => o.activity?.kind !== "sleep");
    add("use", 0.3 + 0.4 * bored, [{ do: "use", item: toy, target: others[0]?.id, why: `I want to spend time with my ${itemDef(w, toy).name}.` }], `use:${toy}`);
  }

  // play at the place that is least familiar right now
  {
    const spot = [...PLAY_PLACES].sort((a, b) => familiarity(c, `play:${a}`, w.t) - familiarity(c, `play:${b}`, w.t) || (a === c.place ? -1 : 1))[0];
    const topic = topicOf("play", spot);
    add("play", 0.2 + 0.8 * bored, [...walkTo(c.place, spot, bored > 0.4 ? "I am bored; time for a wander somewhere new." : "A change of scene."), { do: "play", why: "Something new to look at." }], `play:${spot}`, (topic ? interestStrength(c, topic) * 0.3 : 0) + pursuitBonus("play", topic));
  }

  // company
  if (awakeHere.length) {
    const o = [...awakeHere].sort((a, b) => familiarity(c, `talk:${a.id}`, w.t) - familiarity(c, `talk:${b.id}`, w.t))[0];
    const line = [...LINES[c.species]].sort((a, b) => familiarity(c, `say:${a}`, w.t) - familiarity(c, `say:${b}`, w.t))[0];
    const topic = topicOf("speak", c.place);
    add("speak", 0.12 + 0.95 * lonely, [{ do: "speak", target: o.id, text: line, why: `${o.sheet.name} is here and I want company.` }], `talk:${o.id}`, (topic ? interestStrength(c, topic) * 0.3 : 0) + pursuitBonus("speak", topic));
    // a gift, only from a surplus, and never straight back or to the same friend again and again
    const spare = sellables.length >= 2 ? sellables.find((i) => !giftBlocked(w, c, o, i)) : undefined;
    if (spare) add("gift", 0.3 + 0.2 * lonely, [{ do: "gift", target: o.id, item: spare as ItemId, why: `I have more than I need; ${o.sheet.name} might like this.` }], `gift:${o.id}`);
  } else if (lonely > 0.35) {
    const spots = Object.values(w.creatures).filter((o) => o.id !== c.id && o.activity?.kind !== "sleep").map((o) => o.place);
    if (spots.length) {
      const spot = pick(w, spots);
      add("walk", 0.9 * lonely, [{ do: "walk", place: spot, why: "I want some company." }]);
    }
  }

  for (const o of ruleLibraryOptions(w, c)) add("make", o.want, o.moves, o.key);
  const build = ruleBuildOption(w, c);
  if (build) add("propose_build", build.want, build.moves, build.key);

  const read = ruleReadOption(w, c);
  if (read) add("read_book", read.want * (0.8 + bored), read.moves, read.key);
  if (cardsToday(w, c) === 0 && c.energy > 0.3) {
    const line = [...cardLines(c)].sort((a, b) => familiarity(c, `card:${a}`, w.t) - familiarity(c, `card:${b}`, w.t))[0];
    const move: Move = { do: "send_postcard", text: line, why: "I would like to tell someone far away how things are." };
    if (!checkPostcardMove(w, c, move)) {
      add("send_postcard", 0.2 + 0.25 * lonely, [move], `card:${line}`);
    }
  }

  if (c.energy < 0.7) add("rest", (1 - c.energy) * 0.5, [{ do: "rest", why: "Taking it slowly." }]);

  plans.sort((a, b) => b.score - a.score);
  const best = plans[0];
  if (!best || best.score < 0.15) return [{ do: c.energy < 0.6 ? "rest" : "wait", why: "Nothing calls to me right now." }];
  for (const m of best.moves) if (m.do === "speak" && m.text) noteExposure(c, `say:${m.text}`, w.t);
  for (const m of best.moves) if (m.do === "send_postcard" && m.text) noteExposure(c, `card:${m.text}`, w.t);
  return best.moves;
}
