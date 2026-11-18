// Rule-based fallback mind. Free, instant, deterministic given the world seed.
// Used when the model is slow, unfunded, over budget, or disabled, so a creature never freezes.
// It uses the same novelty/interest/pursuit logic as the world: after urgent needs, each option is
// scored by how much the creature wants it times how fresh it is, so non-model moments vary too.
import { appraise, needLevel } from "./affect";
import { BREAD_PRICE, ITEMS, SPECIES, TEA_PRICE } from "./content";
import { GATHERS_PER_DAY, GATHER_PLACES, GEAR_IDS, GOODS, SEED_PRICE, capReached, gathersToday, isRaining, weatherNow } from "./goods";
import { plantError } from "./builder";
import { familiarity, interestStrength, noteExposure, novelty, payoffScale, stepKindFor, topicOf } from "./novelty";
import { itemDef } from "./items";
import { ruleBuildOption } from "./builder";
import { ruleReadOption } from "./books";
import { cardLines, cardsToday, checkPostcardMove } from "./postcards";
import { ruleLibraryOptions } from "./library";
import { MAX_CARRY, usable, clockOf, creaturesAt, giftBlocked, pick, rand, sellBlocked, teaBlocked } from "./sim";
import type { Creature, ItemId, Move, MoveKind, PlaceId, World } from "./types";

const LINES: Record<Creature["species"], string[]> = {
  otter: ["Afternoon. Slow day.", "You look like you could use some tea.", "I fixed something. Nobody asked me to.", "The workshop smells of oil and rain today.", "Mind the loose plank by the pond."],
  magpie: ["Hello hello! Seen anything shiny today?", "Guess what I heard by the fountain!", "Don't tell anyone, but I'm a bit bored!", "I traded a button for a story. Good deal!", "Have you noticed how the fountain sparkles at noon?"],
  toad: ["Ah... hello.", "I have been thinking about mud... it is a fine subject.", "Do you ever... wonder where the pond goes at night?", "The reeds were unusually talkative this morning...", "I made something... it may be a remedy, or a mistake."],
};

/** What a stated goal nudges toward: keywords in the creature's own intention (set by the model, then followed by the rules mind). */
const GOAL_WORDS: Partial<Record<MoveKind, string[]>> = {
  speak: ["talk", "friend", "chat", "company", "visit", "tell", "share", "ask", "listen", "gossip"],
  play: ["play", "wander", "explore", "walk", "stroll", "park", "pond", "fountain", "relax", "enjoy"],
  craft: ["craft", "make", "mend", "repair", "fix", "build", "brew", "trinket", "potion", "finish"],
  read_book: ["read", "book", "story", "stories", "learn"],
  make: ["write", "note", "journal", "draw", "plan", "diary", "poem"],
  rest: ["rest", "calm", "quiet", "slow", "recover"],
  send_postcard: ["postcard", "letter", "far away"],
  gift: ["gift", "give", "surprise"],
};
export function goalBonus(c: Creature, kind: MoveKind): number {
  const g = c.goal?.toLowerCase();
  const words = GOAL_WORDS[kind];
  return g && words && words.some((x) => g.includes(x)) ? 0.25 : 0;
}

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
  const food = [...c.inventory].filter((i) => itemDef(w, i).food > 0).sort((a, b) => itemDef(w, b).food - itemDef(w, a).food)[0];
  const sellables = c.inventory.filter((i) => itemDef(w, i).sell > 0 && !sellBlocked(w, c, i)); // the stall takes only so many of one thing in a row
  const heldSellables = c.inventory.filter((i) => itemDef(w, i).sell > 0).length;
  const say = (xs: string[]) => pick(w, xs); // a few ways to put the same thing, chosen by the world's seeded rng
  const craftItem = SPECIES[c.species].craft;
  const awakeHere = creaturesAt(w, c.place, c.id).filter((o) => o.activity?.kind !== "sleep");

  const walkTo = (from: PlaceId, p: PlaceId, why: string): Move[] => (from === p ? [] : [{ do: "walk", place: p, why }]);

  const eatPlan = (): Move[] | null => {
    if (food) return [{ do: "eat", item: food, why: "I am hungry and I have something to eat." }];
    if (c.coins >= BREAD_PRICE && w.bakeryStock > 0 && c.inventory.length < MAX_CARRY) // hands full: sell something first
      return [...walkTo(c.place, "bakery", "I am hungry; the bakery has bread."), { do: "buy_food", why: "Bread, please." }, { do: "eat", item: "bread", why: "Eating it while it is warm." }];
    if (c.energy > 0.2 && c.inventory.length < MAX_CARRY && w.berries > 0 && gathersToday(w, c) < GATHERS_PER_DAY)
      return [...walkTo(c.place, GATHER_PLACES.includes(c.place) ? c.place : "park", "I am hungry; berries are free."), { do: "gather", why: "Berries will do for now." }, { do: "eat", item: "berries", why: "Eating them fresh." }];
    if (sellables.length) return [...walkTo(c.place, "fountain", say(["I need coins for food.", "I should sell something and eat."])), { do: "sell", item: sellables[0], why: say(["Selling to buy bread.", "A sale will pay for a meal.", "Coins for bread, then."]) }];
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
    plans.push({ score: want * payoffScale(nov) + topicBonus + goalBonus(c, kind) - walkPenalty + rand(w) * 0.08, moves });
  };
  const pursuit = c.pursuit;
  const pursuitBonus = (kind: MoveKind, topic?: string) => (pursuit && topic === pursuit.topic && stepKindFor(pursuit.topic) === kind ? 0.35 : 0);

  if (sellables.length) {
    const want = Math.min(0.95, 0.3 * heldSellables + (c.coins < 8 ? 0.25 : 0));
    add("sell", want, [...walkTo(c.place, "fountain", say(["I have things to sell.", "Off to the stall with my wares.", "Time to see what the stall will give me."])), { do: "sell", item: sellables[0], why: say(["Turning it into coins.", "Maybe someone will buy this.", "A fair price, I hope.", "One less thing to carry.", "Putting it out on the stall."]) }], `sell:${sellables[0]}`);
  }

  if (c.energy > 0.35 && c.inventory.length < MAX_CARRY) {
    const topic = topicOf("craft", "workshop", craftItem);
    const want = 0.5 - 0.12 * heldSellables;
    add("craft", want, [...walkTo(c.place, "workshop", say(["I feel like making something.", "The workshop is calling.", "My hands want a job."])), { do: "craft", why: say(["Keeping my hands busy.", "Let me see what I can make.", "Something useful, I hope.", "One more, carefully done."]) }], `craft:${craftItem}`, (topic ? interestStrength(c, topic) * 0.3 : 0) + pursuitBonus("craft", topic));
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
    add("play", 0.2 + 0.8 * bored, [...walkTo(c.place, spot, bored > 0.4 ? say(["I am bored; time for a wander somewhere new.", "Enough sitting still; somewhere different.", "I want to see something new."]) : say(["A change of scene.", "A little fresh air.", "A stroll will do me good."])), { do: "play", why: say(["Something new to look at.", "Just a bit of fun.", "Nothing to do but enjoy it."]) }], `play:${spot}`, (topic ? interestStrength(c, topic) * 0.3 : 0) + pursuitBonus("play", topic));
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

  // a snack from the pocket (berries, fish) when somewhat hungry: free food is not left to spoil
  if (food && hunger > 0.35 && !food.startsWith("x-") && itemDef(w, food).food > 0) add("eat", 0.15 + 0.6 * hunger, [{ do: "eat", item: food, why: say(["A little something to eat.", "A snack, I think."]) }], `item:${food}`);

  // a cup of tea: cheap comfort, mostly for those who like it; novelty makes a second and third cup less tempting
  {
    const likes = appraise(c, ITEMS.tea.tags) > 0;
    const comfort = needLevel(c, "comfort");
    const have = c.inventory.includes("tea");
    const canBuy = c.coins >= TEA_PRICE + BREAD_PRICE && c.inventory.length < MAX_CARRY && !teaBlocked(w, c);
    if (have || canBuy) {
      const want = 0.2 + 0.7 * comfort + (likes ? 0.2 : 0) + (c.mood < 0.5 ? 0.1 : 0);
      const moves: Move[] = have
        ? [{ do: "eat", item: "tea", why: say(["A cup of tea, while it is warm.", "Tea, at last."]) }]
        : [...walkTo(c.place, "bakery", say(["I fancy a cup of tea.", "Tea at the bakery sounds right."])), { do: "buy_food", item: "tea", why: "One tea, please." }, { do: "eat", item: "tea", why: "Warm hands, warm cup." }];
      add("eat", want, moves, "item:tea");
    }
  }

  // town objects: berries, fishing, kite, seeds, and a little gear-making. All scored by novelty like everything else.
  {
    const hasWhere = (id: string) => c.inventory.includes(id);
    const room = c.inventory.length < MAX_CARRY;
    const reserve = 10; // coins always kept for bread
    if (room && c.energy > 0.2 && gathersToday(w, c) < GATHERS_PER_DAY && w.berries > 0) {
      const spot: PlaceId = GATHER_PLACES.includes(c.place) ? c.place : "park";
      add("gather", 0.18 + 0.35 * hunger + 0.1 * bored, [...walkTo(c.place, spot, say(["Berries should be ripe by now.", "I could pick a few berries."])), { do: "gather", why: say(["Free and sweet.", "A handful of berries will do.", "Picking berries, slowly."]) }], "gather:berries");
    }
    if (hasWhere("rod") && c.energy > 0.2 && room) add("use", 0.3 + 0.35 * bored, [...walkTo(c.place, "pond", "I want to fish."), { do: "use", item: "rod", why: say(["A quiet hour with the rod.", "Maybe something will bite."]) }], "use:rod");
    if (hasWhere("kite") && !isRaining(w) && c.energy > 0.2) add("use", 0.3 + 0.3 * bored + (weatherNow(w) === "wind" ? 0.25 : 0), [...walkTo(c.place, "park", "Good day for a kite."), { do: "use", item: "kite", why: say(["Up it goes.", "Time to fly the kite."]) }], "use:kite");
    if (hasWhere("seeds") && !plantError(w, "park")) add("use", 0.35, [...walkTo(c.place, "park", "I will plant these at the park."), { do: "use", item: "seeds", why: "Something to grow." }], "plant:seeds");
    else if (!hasWhere("seeds") && room && c.coins >= SEED_PRICE + reserve + 4 && !capReached(w, "seeds") && !plantError(w, "park")) add("buy_food", 0.38, [...walkTo(c.place, "bakery", "The bakery sells seed packets."), { do: "buy_food", item: "seeds", why: "Seeds for the park." }], "item:seeds");
    if (room && c.energy > 0.35) {
      const wanted = GEAR_IDS.filter((g) => !hasWhere(g) && !capReached(w, g) && c.coins >= (GOODS[g].craftCost ?? 0) + reserve);
      const g = [...wanted].sort((a, b) => familiarity(c, `craft:${b}`, w.t) - familiarity(c, `craft:${a}`, w.t)).reverse()[0];
      if (g) add("craft", 0.42 + (g === "umbrella" && isRaining(w) ? 0.3 : 0), [...walkTo(c.place, "workshop", `A ${ITEMS[g].name} would be handy.`), { do: "craft", item: g, why: `I will make a ${ITEMS[g].name}.` }], `craft:${g}`);
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

  if (c.energy < 0.7) add("rest", (1 - c.energy) * 0.5, [{ do: "rest", why: say(["Taking it slowly.", "A short rest.", "Letting the day pass a moment."]) }]);

  plans.sort((a, b) => b.score - a.score);
  const best = plans[0];
  if (!best || best.score < 0.15) return [{ do: c.energy < 0.6 ? "rest" : "wait", why: "Nothing calls to me right now." }];
  for (const m of best.moves) if (m.do === "speak" && m.text) noteExposure(c, `say:${m.text}`, w.t);
  for (const m of best.moves) if (m.do === "send_postcard" && m.text) noteExposure(c, `card:${m.text}`, w.t);
  return best.moves;
}
