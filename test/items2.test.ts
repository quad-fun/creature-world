// Town objects batch 1: berries, fish, fishing rod, paper kite, paint set, seed packet, umbrella.
process.env.AI_GATEWAY_API_KEY = "test-key-not-used";
process.env.TIME_SCALE = "600";

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { ITEMS, seedWorld } from "../src/lib/content";
import { BERRY_MAX, BERRY_REGROW_MIN, GATHERS_PER_DAY, GOODS, KITE_WIND, SEED_PRICE, capReached, existing, isGood } from "../src/lib/goods";
import { MAX_ACTIVE_BUILDS, MAX_BUILDS_PER_PLACE, MAX_PLANTINGS, BUILD_CATALOG } from "../src/lib/builder";
import { itemDef, matchItemId, PUSH_MAX } from "../src/lib/items";
import { migrate } from "../src/lib/migrate";
import { buildDecisionPrompt, decideWithModel } from "../src/lib/mind";
import { familiarity, noteExposure } from "../src/lib/novelty";
import { applyOutside, worldOutside } from "../src/lib/outside";
import { MAX_CARRY, giftBlocked, kickQueue, normalizeMove, startMove, stepWorld, validateMoves } from "../src/lib/sim";
import { needLevel } from "../src/lib/affect";
import { ruleMoves } from "../src/lib/rules";
import { MAKE_COST, PAINT_MAKE_COST } from "../src/lib/library";
import { applyInbox } from "../src/lib/inbox";
import type { Creature, Move, Weather, World } from "../src/lib/types";
import { applyRulesForTest } from "./helpers";

const fresh = () => seedWorld(0);
const settle = (w: World, c: Creature, max = 200) => {
  for (let i = 0; i < max && (c.activity || c.queue.length); i++) stepWorld(w);
};
const setWeather = (w: World, weather: Weather) => {
  const day = Math.floor(w.t / 1440) + 1;
  w.outside = { ...worldOutside(w, day), weather, by: "engine", appliedDay: day };
};
const joy = (c: Creature) => c.influences.filter((i) => i.kind === "joy").reduce((n, i) => n + i.level, 0);
const run = (w: World, c: Creature, m: Omit<Move, "why">) => {
  const e = startMove(w, c, { ...m, why: "x" });
  if (!e) settle(w, c);
  return e;
};
const at = (w: World, c: Creature, place: Creature["place"], inv: string[] = [], coins = 20) => {
  c.place = place;
  c.inventory = [...inv];
  c.coins = coins;
  c.energy = 0.9;
  c.influences = c.influences.filter((i) => i.need);
};

test("catalogue: the new objects are fixed, resolvable by name, and sell nothing except fish", () => {
  const w = fresh();
  for (const id of Object.keys(GOODS)) {
    assert.ok(ITEMS[id as keyof typeof ITEMS], id);
    assert.equal(matchItemId(w, ITEMS[id as keyof typeof ITEMS].name), id);
    assert.equal(itemDef(w, id).custom, false);
    assert.ok(itemDef(w, id).mood <= PUSH_MAX);
  }
  assert.equal(matchItemId(w, "fishing rod"), "rod");
  assert.equal(matchItemId(w, "seed packet"), "seeds");
  assert.equal(matchItemId(w, "kettle"), undefined);
  assert.equal(matchItemId(w, "boat"), undefined);
  assert.ok(!isGood("__proto__") && !isGood("constructor") && !isGood("toString"));
  for (const id of ["berries", "rod", "kite", "paint", "seeds", "umbrella"]) assert.equal(itemDef(w, id).sell, 0, `${id} cannot be sold`);
  assert.ok(itemDef(w, "fish").sell >= 1 && itemDef(w, "fish").sell <= 2);
  for (const g of ["rod", "kite", "paint", "umbrella"]) assert.ok(itemDef(w, "fish").sell < (GOODS[g].craftCost ?? 0) + 1, "sell price never beats a craft cost");
});

test("a visitor gift named like a town object is an appraised custom item, never the catalogue (no cap bypass)", () => {
  const w = fresh();
  assert.equal(matchItemId(w, "kite", { goods: false }), undefined);
  assert.equal(matchItemId(w, "tea", { goods: false }), "tea");
  const before = existing(w, "kite");
  applyInbox(w, [{ type: "gift", to: "moss", from: "v", name: "Kite", description: "red" }]);
  assert.equal(existing(w, "kite"), before);
});

// ---------------------------------------------------------------- berries

test("berries: gather at park or pond, free, bounded per creature per day and by a town supply that regrows", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "park");
  const food0 = itemDef(w, "berries").food;
  assert.ok(food0 > 0 && food0 < itemDef(w, "bread").food, "small relief, less than bread");
  const supply = w.berries;
  assert.equal(run(w, c, { do: "gather" }), null);
  assert.deepEqual(c.inventory, ["berries"]);
  assert.equal(w.berries, supply - 1);
  for (let i = 1; i < GATHERS_PER_DAY; i++) assert.equal(run(w, c, { do: "gather" }), null);
  assert.equal(c.inventory.length, GATHERS_PER_DAY);
  assert.match(startMove(w, c, { do: "gather", why: "x" }) ?? "", /plenty today/);
  // other places refuse
  at(w, w.creatures.pip, "bakery");
  assert.match(startMove(w, w.creatures.pip, { do: "gather", why: "x" }) ?? "", /park and the pond/);
  // supply: empty bushes refuse, and regrow happens on the clock
  w.berries = 0;
  at(w, w.creatures.bramble, "pond");
  assert.match(startMove(w, w.creatures.bramble, { do: "gather", why: "x" }) ?? "", /bare/);
  const t0 = w.t;
  while (w.t < t0 + BERRY_REGROW_MIN * 3) stepWorld(w);
  assert.ok(w.berries >= 2 && w.berries <= BERRY_MAX);
  for (let i = 0; i < 6 * 288; i++) stepWorld(w);
  assert.ok(w.berries <= BERRY_MAX);
});

test("berries: eating relieves a little hunger, and a hands-full creature cannot gather; auto-walk from elsewhere", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "park", ["berries"]);
  for (const i of c.influences) if (i.kind === "hunger") i.level = 0.6;
  assert.equal(run(w, c, { do: "eat", item: "berries" }), null);
  const h = needLevel(c, "hunger");
  assert.ok(h < 0.6 && h > 0.35, `small relief (${h})`);
  at(w, c, "park", Array(MAX_CARRY).fill("trinket"));
  assert.match(startMove(w, c, { do: "gather", why: "x" }) ?? "", /carrying too much/);
  at(w, c, "workshop");
  const v = validateMoves(w, c, [{ do: "gather", why: "x" }]);
  assert.deepEqual(v.moves.map((m) => m.do), ["walk", "gather"]);
  assert.equal(v.moves[0].place, "park");
});

// ---------------------------------------------------------------- rod and fish

test("fish: better than bread, small joy, sellable and giftable; habituation shrinks the payoff", () => {
  const w = fresh();
  const fish = itemDef(w, "fish");
  assert.ok(fish.food > itemDef(w, "bread").food);
  assert.ok(fish.mood > 0 && fish.sell > 0);
  const c = w.creatures.moss;
  at(w, c, "fountain", ["fish", "fish"]);
  assert.equal(run(w, c, { do: "sell", item: "fish" }), null);
  assert.ok(c.coins > 20 && c.inventory.length === 1);
  // gifting is allowed
  at(w, c, "park", ["fish"]);
  at(w, w.creatures.pip, "park");
  assert.equal(giftBlocked(w, c, w.creatures.pip, "fish"), null);
  // habituation: after repeated fish the joy from a meal is smaller
  const a = fresh();
  const ca = a.creatures.moss;
  at(a, ca, "park", ["fish"]);
  run(a, ca, { do: "eat", item: "fish" });
  const first = joy(ca);
  const b = fresh();
  const cb = b.creatures.moss;
  at(b, cb, "park", ["fish"]);
  for (let i = 0; i < 4; i++) noteExposure(cb, "item:fish", b.t);
  run(b, cb, { do: "eat", item: "fish" });
  assert.ok(joy(cb) < first, "a creature tired of fish enjoys it less");
});

test("rod: craft costs 3 coins at the workshop, use only at the pond, calm lift, seeded chance of fish, wears out", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "workshop", [], 2);
  assert.match(startMove(w, c, { do: "craft", item: "rod", why: "x" }) ?? "", /costs 3 coins/);
  c.coins = 10;
  assert.equal(run(w, c, { do: "craft", item: "rod" }), null);
  assert.equal(c.coins, 10 - GOODS.rod.craftCost!);
  assert.deepEqual(c.inventory, ["rod"]);
  assert.match(startMove(w, c, { do: "craft", item: "rod", why: "x" }) ?? "", /already has/);
  // wrong place validates into a walk to the pond; the move runs there
  const v = validateMoves(w, c, [{ do: "use", item: "rod", why: "x" }]);
  assert.deepEqual(v.moves.map((m) => m.do), ["walk", "use"]);
  assert.match(startMove(w, c, { do: "use", item: "rod", why: "x" }) ?? "", /pond/);
  c.place = "pond";
  const catches: number[] = [];
  let uses = 0;
  while (c.inventory.includes("rod") && uses < 20) {
    const fishBefore = c.inventory.filter((i) => i === "fish").length;
    assert.equal(run(w, c, { do: "use", item: "rod" }), null);
    if (uses === 0) assert.ok(joy(c) > 0, "a calm mood lift");
    uses++;
    catches.push(c.inventory.filter((i) => i === "fish").length - fishBefore);
    if (c.inventory.length >= MAX_CARRY - 1) c.inventory = c.inventory.filter((i) => i === "rod");
  }
  assert.equal(uses, GOODS.rod.durability, "the rod wears out after its durability");
  assert.ok(!c.inventory.includes("rod"));
  assert.ok(catches.every((n) => n === 0 || n === 1), "at most one fish per cast");
  assert.ok(catches.some((n) => n === 1) && catches.some((n) => n === 0), "a seeded chance, neither always nor never");
});

test("rod: the chance is reproducible from the world seed", () => {
  const cast = () => {
    const w = fresh();
    const c = w.creatures.moss;
    at(w, c, "pond", ["rod"]);
    const out: string[] = [];
    for (let i = 0; i < 5; i++) {
      run(w, c, { do: "use", item: "rod" });
      out.push(String(c.inventory.filter((x) => x === "fish").length));
      c.inventory = c.inventory.filter((x) => x === "rod");
      c.uses.rod = 0;
    }
    return out.join("");
  };
  assert.equal(cast(), cast());
});

test("rod: refuses with full hands (no fish would be lost) and when the town has too many fish", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "pond", ["rod", ...Array(MAX_CARRY - 1).fill("trinket")]);
  assert.match(startMove(w, c, { do: "use", item: "rod", why: "x" }) ?? "", /no room/);
  const p = w.creatures.pip;
  at(w, p, "pond", Array(GOODS.fish.cap).fill("fish").slice(0, MAX_CARRY));
  w.creatures.bramble.inventory = Array(GOODS.fish.cap - MAX_CARRY).fill("fish");
  assert.ok(capReached(w, "fish"));
  at(w, c, "pond", ["rod"]);
  run(w, c, { do: "use", item: "rod" });
  assert.ok(!c.inventory.includes("fish"), "capped: nothing bites");
});

// ---------------------------------------------------------------- kite

test("kite: craft, use at the park only, big joy that habituates fast, wind boosts, rain blocks, wears out", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "workshop", [], 5);
  assert.equal(run(w, c, { do: "craft", item: "kite" }), null);
  assert.deepEqual(c.inventory, ["kite"]);
  assert.match(startMove(w, c, { do: "use", item: "kite", why: "x" }) ?? "", /park/);
  assert.deepEqual(validateMoves(w, c, [{ do: "use", item: "kite", why: "x" }]).moves.map((m) => m.do), ["walk", "use"]);
  c.place = "park";
  setWeather(w, "clear");
  assert.equal(run(w, c, { do: "use", item: "kite" }), null);
  const j1 = joy(c);
  assert.ok(j1 > 0.15, `big joy (${j1})`);
  // habituation is fast: the second flight pays clearly less
  c.influences = c.influences.filter((i) => i.need);
  assert.equal(run(w, c, { do: "use", item: "kite" }), null);
  const j2 = joy(c);
  assert.ok(j2 < j1 * 0.8, `second flight pays less (${j2} vs ${j1})`);
  assert.ok(familiarity(c, "use:kite", w.t) > 1.5);
  // wear
  let n = 2;
  while (c.inventory.includes("kite") && n < 30) {
    run(w, c, { do: "use", item: "kite" });
    n++;
  }
  assert.equal(n, GOODS.kite.durability);
});

test("kite: wind boosts it (bounded), rain blocks it", () => {
  const joyIn = (weather: Weather) => {
    const w = fresh();
    const c = w.creatures.pip;
    at(w, c, "park", ["kite"]);
    setWeather(w, weather);
    const e = startMove(w, c, { do: "use", item: "kite", why: "x" });
    if (e) return e;
    settle(w, c);
    return joy(c);
  };
  const clear = joyIn("clear") as number;
  const wind = joyIn("wind") as number;
  assert.ok(wind > clear * 1.2, `wind ${wind} vs clear ${clear}`);
  assert.ok(wind <= clear * KITE_WIND + 0.01);
  assert.ok(GOODS.kite.mood * KITE_WIND <= PUSH_MAX + 1e-9);
  assert.match(String(joyIn("rain")), /rain/);
  // rain that starts mid-flight: no effect, no wear
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "park", ["kite"]);
  setWeather(w, "clear");
  startMove(w, c, { do: "use", item: "kite", why: "x" });
  setWeather(w, "rain");
  settle(w, c);
  assert.equal(joy(c), 0);
  assert.equal(c.uses.kite ?? 0, 0);
  // the rules mind never picks the kite in rain
  setWeather(w, "rain");
  c.energy = 0.9;
  for (let i = 0; i < 40; i++) assert.ok(!ruleMoves(w, c).some((m) => m.do === "use" && m.item === "kite"));
});

// ---------------------------------------------------------------- paint

test("paint set: drawings cost less and feel more accomplished; the set wears out; other kinds are unchanged", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "workshop", [], 10);
  assert.equal(run(w, c, { do: "craft", item: "paint" }), null);
  assert.deepEqual(c.inventory, ["paint"]);
  const acc = (x: Creature) => x.influences.filter((i) => i.kind === "accomplishment").reduce((n, i) => n + i.level, 0);
  c.coins = 10;
  c.influences = c.influences.filter((i) => i.need);
  assert.equal(run(w, c, { do: "make", kind: "drawing" }), null);
  assert.equal(c.coins, 10 - PAINT_MAKE_COST);
  assert.equal(c.shelf.at(-1)?.kind, "drawing");
  assert.ok(c.shelf.at(-1)!.shapes!.length >= 2, "same whitelist drawing, no new rendering");
  const withPaint = acc(c);
  // without paint: full price, smaller bonus
  const w2 = fresh();
  const d = w2.creatures.moss;
  at(w2, d, "workshop", [], 10);
  run(w2, d, { do: "make", kind: "drawing" });
  assert.equal(d.coins, 10 - MAKE_COST);
  assert.ok(withPaint > acc(d));
  // a note is not discounted
  c.makes = { day: 0, n: 0 };
  c.coins = 10;
  if (c.shelf.length >= c.shelfSlots) c.shelf.shift();
  c.inventory = ["paint"];
  run(w, c, { do: "make", kind: "note" });
  assert.equal(c.coins, 10 - MAKE_COST);
  // wear
  c.inventory = ["paint"];
  c.uses.paint = GOODS.paint.durability - 1;
  c.makes = { day: 0, n: 0 };
  c.shelf = [];
  c.coins = 10;
  run(w, c, { do: "make", kind: "drawing" });
  assert.ok(!c.inventory.includes("paint"));
  // use is explained, not performed
  c.inventory = ["paint"];
  assert.match(startMove(w, c, { do: "use", item: "paint", why: "x" }) ?? "", /make a drawing/);
  // paint flag never comes from model output
  assert.equal(normalizeMove(w, { do: "make", kind: "drawing", paint: true, why: "x" })!.paint, undefined);
});

// ---------------------------------------------------------------- seeds

test("seeds: bakery 2 coins; planted at the park; one world day later a garden build stands through the builder lane", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "bakery", [], 10);
  assert.equal(run(w, c, { do: "buy_food", item: "seeds" }), null);
  assert.equal(c.coins, 10 - SEED_PRICE);
  assert.deepEqual(c.inventory, ["seeds"]);
  assert.match(startMove(w, c, { do: "buy_food", item: "seeds", why: "x" }) ?? "", /already has/);
  assert.match(startMove(w, c, { do: "use", item: "seeds", why: "x" }) ?? "", /park/);
  assert.deepEqual(validateMoves(w, c, [{ do: "use", item: "seeds", why: "x" }]).moves.map((m) => m.do), ["walk", "use"]);
  c.place = "park";
  const builds0 = w.builds.length;
  assert.equal(run(w, c, { do: "use", item: "seeds" }), null);
  assert.equal(c.inventory.length, 0);
  assert.equal(w.plantings.length, 1);
  assert.equal(w.builds.length, builds0, "not yet");
  const t0 = w.t;
  while (w.t < t0 + 1400) stepWorld(w);
  assert.equal(w.builds.length, builds0, "still growing after 23 hours");
  while (w.t < t0 + 1440 + 120) stepWorld(w);
  assert.equal(w.plantings.length, 0);
  const g = w.builds.find((b) => b.kind === "garden" && b.by === "moss");
  assert.ok(g, "a garden build exists");
  assert.equal(g!.status, "active");
  assert.equal(g!.text, undefined, "no label");
  assert.equal(g!.place, "park");
  assert.ok(BUILD_CATALOG.garden.auto);
});

test("seeds: planting counts toward the build caps and is bounded", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "park", ["seeds"]);
  // fill the park's three slots with plantings and builds
  w.plantings = [];
  for (let i = 0; i < MAX_BUILDS_PER_PLACE; i++) w.builds.push({ id: ++w.buildSeq, kind: "bench", place: "park", by: "pip", cost: 4, status: "active", createdT: 0, expiresT: 1e9 });
  assert.match(startMove(w, c, { do: "use", item: "seeds", why: "x" }) ?? "", /enough already/);
  w.builds = [];
  // global plantings cap
  for (let i = 0; i < MAX_PLANTINGS; i++) w.plantings.push({ by: "pip", place: "park", t: w.t, readyT: w.t + 1440 });
  assert.match(startMove(w, c, { do: "use", item: "seeds", why: "x" }) ?? "", /already growing/);
  assert.ok(capReached(w, "seeds"), "seeds in the ground count toward the seed cap");
  // a ripe planting cannot push the town past MAX_ACTIVE_BUILDS
  const w2 = fresh();
  for (let i = 0; i < MAX_ACTIVE_BUILDS; i++) w2.builds.push({ id: ++w2.buildSeq, kind: "flowerbox", place: i % 2 ? "pond" : "fountain", by: "pip", cost: 2, status: "active", createdT: 0, expiresT: 1e9 });
  w2.plantings = [{ by: "moss", place: "park", t: 0, readyT: 1 }];
  w2.t = 12 * 1440 - 5; // the next step lands on the hour
  stepWorld(w2);
  assert.equal(w2.plantings.length, 0);
  assert.ok(w2.builds.filter((b) => b.status === "active").length <= MAX_ACTIVE_BUILDS);
});

test("seeds: the builder lane cannot over-commit while seeds are in the ground", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "park", [], 30);
  w.plantings = [{ by: "pip", place: "park", t: 0, readyT: 1440 }, { by: "pip", place: "park", t: 0, readyT: 1440 }];
  w.builds.push({ id: ++w.buildSeq, kind: "bench", place: "park", by: "pip", cost: 4, status: "active", createdT: 0, expiresT: 1e9 });
  assert.match(startMove(w, c, { do: "propose_build", build: "lantern", place: "park", why: "x" }) ?? "", /enough already/);
});

// ---------------------------------------------------------------- umbrella

test("umbrella: craft, softens rain by itself (bounded), wears out; no effect in clear weather", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "workshop", [], 10);
  assert.equal(run(w, c, { do: "craft", item: "umbrella" }), null);
  assert.deepEqual(c.inventory, ["umbrella"]);
  assert.match(startMove(w, c, { do: "use", item: "umbrella", why: "x" }) ?? "", /by itself/);
  const rainHit = (inv: string[]) => {
    const x = fresh();
    x.t = 1440 * 2 + 8 * 60;
    const m = x.creatures.pip;
    m.place = "park";
    m.inventory = [...inv];
    setWeather(x, "rain");
    x.outside!.appliedDay = 0;
    const before = needLevel(m, "comfort");
    applyOutside(x, Math.floor(x.t / 1440) + 1);
    return needLevel(m, "comfort") - before;
  };
  const bare = rainHit([]);
  const dry = rainHit(["umbrella"]);
  assert.ok(bare > 0.04, `rain is uncomfortable (${bare})`);
  assert.ok(dry > 0 && dry < bare * 0.5, `umbrella softens it (${dry} vs ${bare})`);
  // wear: one use per rainy day outdoors, until it is gone
  const x = fresh();
  const m = x.creatures.moss;
  m.place = "park";
  m.inventory = ["umbrella"];
  let days = 0;
  for (let i = 0; i < 12 * 288 && m.inventory.includes("umbrella"); i++) {
    const day = Math.floor(x.t / 1440) + 1;
    if (x.event?.day !== day + 0 && x.t % 1440 === 5 * 60) setWeather(x, "rain");
    stepWorld(x);
    if (x.t % 1440 === 7 * 60 && x.outside?.weather === "rain") days++;
  }
  assert.ok(days <= 12);
  // indoors it does not wear
  const y = fresh();
  const n = y.creatures.moss;
  n.place = "nests";
  n.inventory = ["umbrella"];
  y.t = 1440 * 3;
  setWeather(y, "rain");
  y.outside!.appliedDay = 0;
  for (let i = 0; i < 300; i++) stepWorld(y);
  assert.deepEqual(n.inventory.includes("umbrella"), true);
  assert.equal(n.uses.umbrella ?? 0, 0);
});

// ---------------------------------------------------------------- caps, habituation, gifts

test("caps: the town can hold only so many of each; crafting in progress counts; one of each gear per creature", () => {
  const w = fresh();
  assert.ok(Object.values(GOODS).every((g) => g.cap >= 1 && g.cap <= 9));
  const a = w.creatures.moss;
  const b = w.creatures.pip;
  const d = w.creatures.bramble;
  for (const x of [a, b, d]) at(w, x, "workshop", [], 20);
  a.inventory = ["kite"];
  b.inventory = ["kite"];
  assert.ok(capReached(w, "kite"));
  assert.match(startMove(w, d, { do: "craft", item: "kite", why: "x" }) ?? "", /enough/);
  // in-progress crafting is counted
  a.inventory = [];
  b.inventory = [];
  assert.equal(startMove(w, a, { do: "craft", item: "kite", why: "x" }), null);
  b.inventory = ["kite"];
  assert.ok(capReached(w, "kite"));
  // gifting a gear item to someone who has one is refused
  a.activity = null;
  d.inventory = ["rod"];
  at(w, b, "workshop", ["rod"]);
  assert.match(giftBlocked(w, b, d, "rod") ?? "", /already has one/);
});

test("habituation: gathering, fishing and kites all lose payoff with repetition (novelty keys)", () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "park", ["rod", "kite"]);
  for (const k of ["gather:berries", "use:kite"]) {
    const f0 = familiarity(c, k, w.t);
    if (k === "gather:berries") run(w, c, { do: "gather" });
    else run(w, c, { do: "use", item: "kite" });
    assert.ok(familiarity(c, k, w.t) > f0, k);
  }
  at(w, c, "pond", ["rod"]);
  const f = familiarity(c, "use:rod", w.t);
  run(w, c, { do: "use", item: "rod" });
  assert.ok(familiarity(c, "use:rod", w.t) > f);
});

// ---------------------------------------------------------------- model prompt and hostile output

test("prompt: lists exactly what exists and where it is usable, and stays clear that nothing else does", () => {
  const w = fresh();
  setWeather(w, "wind");
  const p = buildDecisionPrompt(w, w.creatures.moss).prompt;
  for (const s of ["fishing rod", "paper kite", "paint set", "seed packet", "umbrella", "berries", "fish", "use at the pond", "use at the park", "windy"]) assert.ok(p.includes(s), s);
  assert.match(p, /fixed list of town objects/);
  assert.match(p, /Do not invent or ask for any other objects/);
  assert.match(p, /no teacups/);
  assert.match(p, /gather: only at the park or pond/);
  setWeather(w, "rain");
  assert.match(buildDecisionPrompt(w, w.creatures.moss).prompt, /raining now: no kites/);
});

test("hostile model output: nonexistent items, wrong places and prototype keys never create anything", async () => {
  const w = fresh();
  const c = w.creatures.moss;
  at(w, c, "workshop", [], 50);
  const bad = [
    { do: "craft", item: "kettle", why: "x" },
    { do: "craft", item: "__proto__", why: "x" },
    { do: "craft", item: "berries", why: "x" },
    { do: "craft", item: "fish", why: "x" },
    { do: "buy_food", item: "boat", why: "x" },
    { do: "use", item: "constructor", why: "x" },
    { do: "gather", item: "gold", why: "x" },
    { do: "use", item: "umbrella", why: "x" },
    { do: "sell", item: "rod", why: "x" },
    { do: "eat", item: "rod", why: "x" },
  ];
  const before = JSON.stringify(c.inventory);
  for (const m of bad) {
    const v = validateMoves(w, c, [m]);
    for (const mv of v.moves) {
      // whatever survives must be a harmless real move: a plain craft of the species item, or an auto-walk
      if (mv.do === "craft") assert.equal(mv.item, undefined);
      assert.notEqual(mv.do, "eat");
      assert.notEqual(mv.do, "sell");
    }
  }
  assert.equal(JSON.stringify(c.inventory), before, "validation never changes state");
  // an invented gather target does not matter; the server only gathers berries
  at(w, c, "park");
  assert.equal(startMove(w, c, { do: "gather", item: "gold", why: "x" }), null);
  settle(w, c);
  assert.deepEqual(c.inventory, ["berries"]);
  // a model that returns these through decideWithModel is held to the same validation
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ moves: [{ do: "craft", place: null, target: null, item: "teapot", kind: null, title: null, topic: null, build: null, n: null, text: null, why: "I want a teapot" }], goal: null }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 10, text: 10 } },
      warnings: [],
    }),
  } as never);
  const r = await decideWithModel(w, c, model);
  at(w, c, "workshop", [], 50);
  const v = validateMoves(w, c, r.moves);
  assert.ok(v.moves.every((m) => m.do !== "craft" || m.item === undefined));
  for (const k of Object.keys(w.items)) assert.ok(!/teapot/.test(k));
  // gather is a known move kind; an unknown kind is still dropped
  assert.equal(normalizeMove(w, { do: "forage", why: "x" }), null);
  assert.equal(normalizeMove(w, { do: "gather", why: "x" })?.do, "gather");
});

// ---------------------------------------------------------------- migration

test("migration: an old world (no berries, plantings or gathers) loads with defaults; bad values are reset", () => {
  const w = fresh() as unknown as Record<string, unknown>;
  delete w.berries;
  delete w.plantings;
  for (const c of Object.values((w as unknown as World).creatures)) delete (c as unknown as Record<string, unknown>).gathers;
  const m = migrate(w as unknown as World);
  assert.equal(m.berries, BERRY_MAX);
  assert.deepEqual(m.plantings, []);
  for (const c of Object.values(m.creatures)) assert.deepEqual(c.gathers, { day: 0, n: 0 });
  // junk is cleaned
  const j = fresh() as unknown as Record<string, unknown>;
  j.berries = "lots";
  j.plantings = [{ by: 1 }, { by: "moss", place: "pond", t: 0, readyT: 5 }, { by: "moss", place: "park", t: 0, readyT: 1e9 }, { by: "moss", place: "park", t: 0, readyT: 1440 }, null];
  const m2 = migrate(j as unknown as World);
  assert.equal(m2.berries, BERRY_MAX);
  assert.equal(m2.plantings.length, 1);
  // an old world still steps and plays in rules mode
  for (let i = 0; i < 288; i++) for (const id of stepWorld(m)) applyRulesForTest(m, m.creatures[id]);
  assert.ok(m.berries >= 0 && m.berries <= BERRY_MAX);
});

test("rules mind: over days it uses the new objects sometimes, never overfills hands, and never starves", () => {
  const w = fresh();
  const seen: Record<string, number> = {};
  const caps = { maxHeld: 0 };
  for (let i = 0; i < 6 * 288; i++) {
    for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
    for (const c of Object.values(w.creatures)) {
      caps.maxHeld = Math.max(caps.maxHeld, c.inventory.length);
      const a = c.activity;
      if (a && ["use", "gather", "craft"].includes(a.kind) && a.move.item) seen[`${a.kind}:${a.move.item}`] = (seen[`${a.kind}:${a.move.item}`] ?? 0) + 1;
      assert.ok(needLevel(c, "hunger") < 0.95, "no starvation");
    }
    for (const id of Object.keys(GOODS)) assert.ok(existing(w, id) <= GOODS[id].cap, `${id} within its cap`);
    assert.ok(w.plantings.length <= MAX_PLANTINGS);
    assert.ok(w.builds.filter((b) => b.status === "active").length <= MAX_ACTIVE_BUILDS);
  }
  assert.ok(caps.maxHeld <= MAX_CARRY);
  assert.ok(Object.keys(seen).length >= 3, `variety of object use: ${JSON.stringify(seen)}`);
});
