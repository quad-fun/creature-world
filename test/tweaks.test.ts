process.env.AI_GATEWAY_API_KEY = "test-key-not-used";
process.env.DAILY_CALLS_PER_CREATURE = "25";
process.env.TIME_SCALE = "600";

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { BREAD_PRICE, ITEMS, TEA_PRICE, seedWorld } from "../src/lib/content";
import { CATCHUP_MIN_STEPS, advanceWorld, config } from "../src/lib/engine";
import { itemDef, matchItemId } from "../src/lib/items";
import { migrate } from "../src/lib/migrate";
import { buildDecisionPrompt, modelRef, persona } from "../src/lib/mind";
import { familiarity, noteExposure } from "../src/lib/novelty";
import { goalBonus, ruleMoves } from "../src/lib/rules";
import { MARKET_RECOVERY, MAX_SELL_RUN, kickQueue, sellBlocked, startMove, stepWorld, teaBlocked, validateMoves } from "../src/lib/sim";
import { getStore } from "../src/lib/store";
import { applyRulesForTest } from "./helpers";

const fresh = () => seedWorld(0);
const settle = (w: ReturnType<typeof fresh>, c: ReturnType<typeof fresh>["creatures"][string], max = 40) => {
  for (let i = 0; i < max && (c.activity || c.queue.length); i++) stepWorld(w);
};
const runSteps = (w: ReturnType<typeof fresh>, n: number) => {
  for (let i = 0; i < n; i++) for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
};

// ---------------------------------------------------------------- 1. stall loop

test("stall: a creature cannot sell the same kind more than twice in a row; doing something else clears it", () => {
  const w = fresh();
  const c = w.creatures.pip;
  c.place = "fountain";
  c.inventory = ["trinket", "trinket", "trinket", "trinket"];
  for (let n = 0; n < MAX_SELL_RUN; n++) {
    assert.equal(startMove(w, c, { do: "sell", item: "trinket", why: "x" }), null);
    for (let i = 0; i < 4 && c.activity; i++) stepWorld(w);
  }
  assert.equal(c.sellRun?.n, MAX_SELL_RUN);
  assert.ok(sellBlocked(w, c, "trinket"));
  assert.equal(validateMoves(w, c, [{ do: "sell", item: "trinket", why: "x" }]).moves.length, 0);
  assert.match(startMove(w, c, { do: "sell", item: "trinket", why: "x" }) ?? "", /in a row/);
  assert.equal(c.inventory.length, 2, "a refused sale keeps the item");
  assert.ok(!ruleMoves(w, c).some((m) => m.do === "sell"), "the rules mind does not try either");
  // doing something else (rest) clears it
  startMove(w, c, { do: "rest", why: "x" });
  for (let i = 0; i < 10 && c.activity; i++) stepWorld(w);
  assert.equal(c.sellRun, null);
  assert.equal(sellBlocked(w, c, "trinket"), null);
});

test("stall: a hungry creature may still sell (never starved by the habit rule)", () => {
  const w = fresh();
  const c = w.creatures.pip;
  c.place = "fountain";
  c.inventory = ["trinket"];
  c.sellRun = { item: "trinket", n: 2, t: w.t };
  assert.ok(sellBlocked(w, c, "trinket"));
  for (const i of c.influences) if (i.kind === "hunger") i.level = 0.9;
  assert.equal(sellBlocked(w, c, "trinket"), null);
});

test("market: heavy repeated supply never sinks a price to 1 coin, and it recovers within hours", () => {
  const w = fresh();
  const c = w.creatures.moss;
  c.place = "fountain";
  for (let i = 0; i < 40; i++) {
    c.inventory = ["mended-thing"];
    c.sellRun = null; // as if the creature did something between each sale
    startMove(w, c, { do: "sell", item: "mended-thing", why: "x" });
    for (let k = 0; k < 3 && c.activity; k++) stepWorld(w);
  }
  const price = Math.round(itemDef(w, "mended-thing").sell * w.market["mended-thing"]);
  assert.ok(price >= 2, `price ${price}`);
  assert.ok(w.market["mended-thing"] >= 0.55 - 1e-9);
  const low = w.market["mended-thing"];
  for (let i = 0; i < 24; i++) stepWorld(w); // two world hours
  assert.ok(w.market["mended-thing"] >= low + 24 * MARKET_RECOVERY - 1e-9 || w.market["mended-thing"] === 1);
});

test("ten rules days: no market price at 1 coin, no same-kind run longer than the cap, and nobody starves", () => {
  const w = fresh();
  const floor: Record<string, number> = {};
  const last: Record<string, string> = {};
  const run: Record<string, number> = {};
  let maxRun = 0;
  for (let i = 0; i < 288 * 10; i++) {
    for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
    for (const k of Object.keys(w.market)) floor[k] = Math.min(floor[k] ?? 99, Math.max(1, Math.round(itemDef(w, k).sell * w.market[k])));
    for (const c of Object.values(w.creatures)) {
      const a = c.activity;
      if (!a || a.kind === "walk" || last[c.id + "a"] === String(a.until) + a.kind) continue;
      last[c.id + "a"] = String(a.until) + a.kind;
      const key = a.kind === "sell" ? `sell:${a.move.item}` : a.kind;
      run[c.id] = key === last[c.id] && key.startsWith("sell:") ? (run[c.id] ?? 1) + 1 : 1;
      last[c.id] = key;
      if (key.startsWith("sell:")) maxRun = Math.max(maxRun, run[c.id]);
      assert.ok(c.influences.find((x) => x.kind === "hunger")!.level < 0.99, `${c.id} starving`);
    }
  }
  assert.ok(Object.values(floor).every((v) => v >= 2), JSON.stringify(floor));
  assert.ok(maxRun <= MAX_SELL_RUN, `run ${maxRun}`);
});

test("rules 'why' text varies: a few wordings per move over a few days", () => {
  const w = fresh();
  const whys = new Map<string, Set<string>>();
  for (let i = 0; i < 288 * 4; i++) {
    for (const id of stepWorld(w)) {
      const c = w.creatures[id];
      applyRulesForTest(w, c);
      if (c.activity) (whys.get(c.activity.kind) ?? whys.set(c.activity.kind, new Set()).get(c.activity.kind)!).add(c.activity.move.why);
    }
  }
  assert.ok((whys.get("sell")?.size ?? 0) >= 3, `sell ${[...(whys.get("sell") ?? [])]}`);
  assert.ok((whys.get("craft")?.size ?? 0) >= 3);
});

// ---------------------------------------------------------------- 2. tea

test("tea is a real, cheap, comforting item; the tastes line is not an inventory", () => {
  assert.ok(ITEMS.tea && ITEMS.tea.sell === 0);
  const w = fresh();
  assert.equal(itemDef(w, "tea").kind, "food");
  assert.ok(itemDef(w, "tea").mood > 0);
  assert.equal(matchItemId(w, "tea"), "tea");
  assert.equal(matchItemId(w, "instead of that"), undefined, "whole words only");
  assert.match(persona(w.creatures.moss), /tastes and feelings, not things you own/);
  const p = buildDecisionPrompt(w, w.creatures.moss).prompt;
  assert.match(p, /Only the things listed in what you carry/);
  assert.match(p, /no teacups/);
  assert.match(p, /tea 1 coin/);
});

test("tea: buy at the bakery for a coin, with an auto-walk, no bread stock used; drinking comforts", () => {
  const w = fresh();
  const c = w.creatures.moss;
  c.place = "park";
  c.coins = 5;
  const v = validateMoves(w, c, [{ do: "buy_food", item: "tea", why: "x" }, { do: "eat", item: "tea", why: "x" }]);
  assert.deepEqual(v.moves.map((m) => m.do), ["walk", "buy_food", "eat"]);
  c.place = "bakery";
  const stock = w.bakeryStock;
  assert.equal(startMove(w, c, { do: "buy_food", item: "tea", why: "x" }), null);
  assert.equal(c.coins, 5 - TEA_PRICE);
  assert.equal(w.bakeryStock, stock);
  assert.deepEqual(c.inventory, ["tea"]);
  settle(w, c);
  for (const i of c.influences) if (i.kind === "comfort") i.level = 0.6;
  const before = c.influences.find((i) => i.kind === "comfort")!.level;
  assert.equal(startMove(w, c, { do: "eat", item: "tea", why: "x" }), null);
  settle(w, c);
  assert.ok(c.influences.find((i) => i.kind === "comfort")!.level < before, "comfort eased");
  assert.ok(c.inventory.length === 0);
});

test("tea: habituation stops a creature drinking cup after cup", () => {
  const w = fresh();
  const c = w.creatures.moss;
  c.place = "bakery";
  c.coins = 50;
  noteExposure(c, "item:tea", w.t);
  noteExposure(c, "item:tea", w.t);
  noteExposure(c, "item:tea", w.t);
  assert.ok(familiarity(c, "item:tea", w.t) >= 2.5);
  assert.ok(teaBlocked(w, c));
  assert.match(startMove(w, c, { do: "buy_food", item: "tea", why: "x" }) ?? "", /plenty of tea/);
  assert.equal(c.coins, 50);
});

test("tea: a creature that likes it and has spare coins eventually drinks some in rules mode; bread buys still never overfill hands", () => {
  const w = fresh();
  let teas = 0;
  let seen = 0;
  for (let i = 0; i < 288 * 5; i++) {
    for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
    for (const c of Object.values(w.creatures)) assert.ok(c.inventory.length <= 6);
    for (const f of w.feed) if (f.id > seen) { seen = f.id; if (/cup of tea/.test(f.text)) teas++; } // counted as it happens: the feed keeps only 250 lines
  }
  assert.ok(teas > 0, "tea was drunk");
  assert.ok(teas < 60, `tea is not a loop (${teas})`);
});

// ---------------------------------------------------------------- 3. auto-walk

test("auto-walk: sell, buy_food and craft from the wrong place become a walk to the right place", () => {
  const w = fresh();
  const c = w.creatures.moss;
  c.place = "pond";
  c.inventory = ["mended-thing"];
  c.coins = 6;
  const sell = validateMoves(w, c, [{ do: "sell", item: "mended thing", why: "x" }]);
  assert.deepEqual(sell.moves.map((m) => [m.do, m.place ?? m.item]), [["walk", "fountain"], ["sell", "mended-thing"]]);
  assert.equal(sell.rejected.length, 0);
  const buy = validateMoves(w, c, [{ do: "buy_food", why: "x" }]);
  assert.equal(buy.moves[0].place, "bakery");
  const craft = validateMoves(w, c, [{ do: "craft", why: "x" }]);
  assert.equal(craft.moves[0].place, "workshop");
  // the chain runs for real
  c.queue = sell.moves;
  kickQueue(w, c);
  for (let i = 0; i < 60; i++) stepWorld(w);
  assert.ok(c.coins > 6, "walked and sold");
});

test("auto-walk only when the move would then be valid; the 3 move cap holds; truly invalid output stays rejected", () => {
  const w = fresh();
  const c = w.creatures.moss;
  c.place = "pond";
  c.inventory = [];
  assert.equal(validateMoves(w, c, [{ do: "sell", item: "trinket", why: "x" }]).moves.length, 0, "nothing to sell: no walk");
  c.coins = 0;
  assert.equal(validateMoves(w, c, [{ do: "buy_food", why: "x" }]).moves.length, 0, "no coins: no walk");
  c.coins = 6;
  const many = validateMoves(w, c, [{ do: "craft", why: "a" }, { do: "sell", item: "mended-thing", why: "b" }, { do: "buy_food", why: "c" }]);
  assert.ok(many.moves.length <= 3);
  assert.equal(validateMoves(w, c, [{ do: "dance" } as never]).rejected[0], "unrecognised move");
  c.energy = 0.05;
  assert.equal(validateMoves(w, c, [{ do: "craft", why: "x" }]).moves.length, 0, "too tired: no walk to craft");
});

// ---------------------------------------------------------------- 4. catch-up

const reply = (o: unknown) => ({ content: [{ type: "text", text: JSON.stringify(o) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 900, noCache: 900 }, outputTokens: { total: 100, text: 100 } }, warnings: [] });
const nul = { place: null, target: null, item: null, kind: null, title: null, topic: null, n: null, build: null, listings: null, text: null, why: "ok" };
function counting(goal: string | null = "go and talk with a friend") {
  const calls = { decide: 0 };
  const model = new MockLanguageModelV4({
    doGenerate: async (opts: { prompt: unknown }) => {
      const t = JSON.stringify(opts.prompt);
      if (t.includes("Moves you can choose from")) {
        calls.decide++;
        return reply({ moves: [{ ...nul, do: "wait" }], goal });
      }
      return reply({ diary: ["A day."], self: "I am calm." });
    },
  } as never);
  return { model, calls };
}
const backdate = async (steps: number) => {
  const s = getStore();
  const w = (await s.load())!;
  w.lastRealMs = Date.now() - ((steps * 5) / config().timeScale) * 60_000;
  await s.save(w);
};

test("catch-up: at most one model decision per creature before stepping, and the goal is kept for the rules mind", async () => {
  const s = getStore();
  const seed = seedWorld(Date.now());
  await s.save(seed);
  const { model, calls } = counting();
  modelRef.current = model;
  try {
    await backdate(288);
    const r = await advanceWorld({ force: true });
    // 3 creatures: one catch-up decision each, then at most one present-moment decision each
    assert.ok(calls.decide >= 3 && calls.decide <= 6, `decide ${calls.decide}`);
    assert.ok(Object.values(r.world.creatures).every((c) => c.calls.n <= 4), "per-creature call budget used sparingly");
    assert.ok(Object.values(r.world.creatures).every((c) => c.goal === "go and talk with a friend"));
    assert.ok(r.steps >= CATCHUP_MIN_STEPS);
  } finally {
    modelRef.current = "anthropic/claude-haiku-5.5";
  }
});

test("catch-up: a short gap, a spent daily cap or a tripped breaker adds no catch-up call", async () => {
  const s = getStore();
  const { model, calls } = counting();
  modelRef.current = model;
  try {
    await s.save(seedWorld(Date.now()));
    await backdate(CATCHUP_MIN_STEPS - 2);
    await advanceWorld({ force: true });
    const short = calls.decide;
    assert.ok(short <= 3, `short gap decide ${short}`); // present-moment only

    const w = seedWorld(Date.now());
    const day = new Date().toISOString().slice(0, 10);
    for (const c of Object.values(w.creatures)) c.calls = { day, n: config().dailyCalls };
    await s.save(w);
    await backdate(288);
    calls.decide = 0;
    await advanceWorld({ force: true });
    assert.equal(calls.decide, 0, "cap spent");

    const w2 = seedWorld(Date.now());
    w2.stats.pausedUntilMs = Date.now() + 60_000;
    await s.save(w2);
    await backdate(288);
    await advanceWorld({ force: true });
    assert.equal(calls.decide, 0, "breaker open");
  } finally {
    modelRef.current = "anthropic/claude-haiku-5.5";
  }
});

test("catch-up: a dead model costs one failed call per creature, not a loop", async () => {
  const s = getStore();
  await s.save(seedWorld(Date.now()));
  let n = 0;
  modelRef.current = new MockLanguageModelV4({ doGenerate: async () => { n++; throw new Error("boom"); } } as never);
  try {
    await backdate(288);
    await advanceWorld({ force: true });
    assert.ok(n <= 3 * 2 * 2 + 4, `calls ${n}`); // maxRetries 1 doubles a call; the breaker stops the rest
  } finally {
    modelRef.current = "anthropic/claude-haiku-5.5";
  }
});

test("a stated goal nudges the rules mind toward matching activities", () => {
  const w = fresh();
  const c = w.creatures.moss;
  assert.equal(goalBonus(c, "speak"), 0);
  c.goal = "visit friends and chat";
  assert.ok(goalBonus(c, "speak") > 0);
  assert.equal(goalBonus(c, "craft"), 0);
});

// ---------------------------------------------------------------- migration

test("migrate: old worlds without the new field load, and a bad value is reset", () => {
  const w = fresh() as any;
  for (const c of Object.values(w.creatures) as any[]) delete c.sellRun;
  migrate(w);
  for (const c of Object.values(w.creatures) as any[]) assert.equal(c.sellRun, null);
  w.creatures.moss.sellRun = { item: 5, n: "x" };
  migrate(w);
  assert.equal(w.creatures.moss.sellRun, null);
  w.creatures.moss.sellRun = { item: "trinket", n: 1, t: 10 };
  migrate(w);
  assert.deepEqual(w.creatures.moss.sellRun, { item: "trinket", n: 1, t: 10 });
  assert.ok(BREAD_PRICE > TEA_PRICE);
});

test("a craft that finishes into full hands is set aside, never overfilling the pack", () => {
  const w = fresh();
  const c = w.creatures.moss;
  c.place = "workshop";
  c.inventory = ["bread", "bread", "bread", "bread", "bread"];
  assert.equal(startMove(w, c, { do: "craft", why: "x" }), null);
  c.inventory.push("tea"); // a gift arrives while the work is underway
  for (let i = 0; i < 20 && c.activity; i++) stepWorld(w);
  assert.equal(c.inventory.length, 6);
});
