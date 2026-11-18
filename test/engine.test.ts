process.env.MIND = "rules";

import assert from "node:assert/strict";
import { test } from "node:test";
import { ENERGY_FLOOR, MOOD_FLOOR, PUSH_CAP, activeInfluences, addInfluence, bumpNeed, influenceWord, moodWords, needLevel, stepAffect, totals } from "../src/lib/affect";
import { seedWorld } from "../src/lib/content";
import { buildDecisionPrompt } from "../src/lib/mind";
import { migrate } from "../src/lib/migrate";
import { familiarity, noteExposure, novelty, payoffScale } from "../src/lib/novelty";
import { POST_COOLDOWN, startMove, stepWorld, validateMoves } from "../src/lib/sim";
import { creatureView } from "../src/lib/view";
import type { World } from "../src/lib/types";
import { applyRulesForTest } from "./helpers";

const fresh = () => seedWorld(0);
const run = (w: World, steps: number) => {
  for (let i = 0; i < steps; i++) for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
};

test("influences sum into a capped push on mood and energy", () => {
  const c = fresh().creatures.moss;
  for (const i of c.influences) i.level = 0;
  assert.deepEqual(totals(c), { mood: 0, energy: 0 });
  bumpNeed(c, "hunger", 0.5);
  const one = totals(c);
  assert.ok(one.mood < 0 && one.energy < 0);
  bumpNeed(c, "boredom", 0.5);
  assert.ok(totals(c).mood < one.mood, "a second influence adds to the first");
  for (const i of c.influences) i.level = 1;
  const worst = totals(c);
  assert.equal(worst.mood, PUSH_CAP.moodDown);
  assert.ok(worst.energy >= -PUSH_CAP.energy);
  addInfluence(c, "joy", "a", 1);
  addInfluence(c, "accomplishment", "b", 1);
  addInfluence(c, "joy", "c", 1);
  for (const i of c.influences.filter((x) => !x.need)) i.level = 1;
  for (const i of c.influences.filter((x) => x.need)) i.level = 0;
  assert.equal(totals(c).mood, PUSH_CAP.moodUp);
});

test("a creature cannot spiral to zero, and influences are named in words", () => {
  const c = fresh().creatures.pip;
  for (const i of c.influences) i.level = 1;
  c.mood = 0.5;
  c.energy = 0.04;
  for (let i = 0; i < 500; i++) stepAffect(c, 5);
  assert.ok(c.mood >= MOOD_FLOOR && c.mood > 0.05);
  assert.ok(c.energy >= ENERGY_FLOOR);
  const words = activeInfluences(c).map(influenceWord);
  assert.ok(words.includes("starving") && words.includes("very lonely") && words.includes("bored stiff"));
  assert.match(moodWords(c), /mood, exhausted/);
});

test("temporary influences fade and are removed; same source refreshes instead of stacking", () => {
  const c = fresh().creatures.moss;
  addInfluence(c, "joy", "a gift", 0.6);
  addInfluence(c, "joy", "a gift", 0.4);
  assert.equal(c.influences.filter((i) => i.kind === "joy").length, 1);
  for (let i = 0; i < 400; i++) stepAffect(c, 5);
  assert.equal(c.influences.filter((i) => i.kind === "joy").length, 0);
  assert.ok(c.influences.some((i) => i.kind === "hunger"), "needs persist");
});

test("sleep restores energy and eating relieves hunger", () => {
  const w = fresh();
  const c = w.creatures.moss;
  c.place = "nests";
  c.energy = 0.2;
  c.activity = { kind: "sleep", until: w.t + 600, move: { do: "sleep", why: "" } };
  for (let i = 0; i < 60; i++) stepWorld(w);
  assert.ok(c.energy > 0.6);
  const d = fresh();
  const p = d.creatures.pip;
  bumpNeed(p, "hunger", 0.5);
  const before = needLevel(p, "hunger");
  p.inventory.push("bread");
  p.activity = { kind: "eat", until: d.t, move: { do: "eat", item: "bread", why: "" } };
  stepWorld(d);
  assert.ok(needLevel(p, "hunger") < before);
});

test("novelty: repeats pay less and build boredom; fresh things relieve it", () => {
  const w = fresh();
  const c = w.creatures.moss;
  assert.equal(novelty(c, "act:x", 0), 1);
  noteExposure(c, "act:x", 0);
  noteExposure(c, "act:x", 0);
  assert.ok(novelty(c, "act:x", 0) < 0.5);
  assert.ok(payoffScale(novelty(c, "act:x", 0)) < payoffScale(1));
  assert.ok(familiarity(c, "act:x", 2000) < 0.2, "familiarity decays with time");

  // crafting repeatedly: mood payoff and accomplishment shrink, boredom grows
  const gain: number[] = [];
  const acc: number[] = [];
  c.place = "workshop";
  for (let i = 0; i < 5; i++) {
    c.inventory = [];
    c.mood = 0.5;
    c.influences = c.influences.filter((x) => x.need);
    c.energy = 0.9;
    c.activity = { kind: "craft", until: w.t, move: { do: "craft", why: "" } };
    const b0 = needLevel(c, "boredom");
    stepWorld(w); // finishes the activity
    gain.push(c.mood - 0.5);
    acc.push(c.influences.find((x) => x.kind === "accomplishment")?.level ?? 0);
    if (i === 4) assert.ok(needLevel(c, "boredom") > b0 - 0.05);
  }
  assert.ok(gain[4] < gain[0], `payoff should fall: ${gain.join(",")}`);
  assert.ok(acc[4] < acc[0], `accomplishment should fall: ${acc.join(",")}`);
});

test("a novel place relieves boredom more than a familiar one", () => {
  const w = fresh();
  const c = w.creatures.bramble;
  bumpNeed(c, "boredom", 0.5);
  const b0 = needLevel(c, "boredom");
  c.activity = { kind: "walk", until: w.t, move: { do: "walk", place: "park", why: "" } };
  stepWorld(w);
  const afterFresh = needLevel(c, "boredom");
  assert.ok(afterFresh < b0 + 0.02);
  noteExposure(c, "place:pond", w.t);
  noteExposure(c, "place:pond", w.t);
  noteExposure(c, "place:pond", w.t);
  const b1 = needLevel(c, "boredom");
  c.activity = { kind: "walk", until: w.t, move: { do: "walk", place: "pond", why: "" } };
  stepWorld(w);
  assert.ok(needLevel(c, "boredom") >= b1 - 0.01, "a stale place does not relieve boredom");
});

test("no gift ping-pong: an adversarial proposer cannot bounce items back and forth", () => {
  const w = fresh();
  const pip = w.creatures.pip;
  const bram = w.creatures.bramble;
  pip.place = bram.place = "park";
  pip.inventory = ["trinket"];
  bram.inventory = [];
  let accepted = 0;
  for (let i = 0; i < 6 * 24; i++) {
    // every 10 minutes whoever holds it tries to hand it to the other
    const giver = pip.inventory.includes("trinket") ? pip : bram;
    const taker = giver === pip ? bram : pip;
    for (const c of [pip, bram]) {
      c.activity = null;
      c.queue = [];
    }
    const v = validateMoves(w, giver, [{ do: "gift", target: taker.id, item: "trinket", why: "" }]);
    if (v.moves.length && startMove(w, giver, v.moves[0]) === null) accepted++;
    stepWorld(w);
    for (const c of [pip, bram]) c.place = "park";
  }
  assert.ok(accepted <= 2, `${accepted} ping-pong gifts accepted over a day`);
  // and a straight return is refused outright
  const w2 = fresh();
  w2.creatures.pip.place = w2.creatures.moss.place = "park";
  w2.creatures.pip.inventory = ["trinket"];
  assert.equal(startMove(w2, w2.creatures.pip, { do: "gift", target: "moss", item: "trinket", why: "" }), null);
  const back = validateMoves(w2, w2.creatures.moss, [{ do: "gift", target: "pip", item: "trinket", why: "" }]);
  assert.equal(back.moves.length, 0);
  assert.match(back.rejected[0], /gave me that/);
});

test("crafting stops when carrying too much", () => {
  const w = fresh();
  const moss = w.creatures.moss;
  moss.place = "workshop";
  moss.inventory = Array(6).fill("mended-thing");
  const v = validateMoves(w, moss, [{ do: "craft", why: "" }]);
  assert.equal(v.moves.length, 0);
  assert.match(v.rejected[0], /carrying too much/);
});

test("post cooldown is enforced by the world and stated in the prompt", () => {
  const w = fresh();
  const pip = w.creatures.pip;
  assert.equal(startMove(w, pip, { do: "post", text: "hello town", why: "" }), null);
  pip.activity = null;
  assert.match(String(startMove(w, pip, { do: "post", text: "again", why: "" })), /recently/);
  const { prompt } = buildDecisionPrompt(w, pip);
  assert.match(prompt, new RegExp(`once every ${POST_COOLDOWN} world minutes`));
  assert.match(prompt, /cannot post for about/);
  assert.match(buildDecisionPrompt(w, w.creatures.moss).prompt, /you may post now/);
});

test("prompt carries mood and energy as words, influences by name, interests; never numbers", () => {
  const w = fresh();
  const moss = w.creatures.moss;
  moss.mood = 0.3;
  moss.energy = 0.3;
  bumpNeed(moss, "loneliness", 0.4);
  bumpNeed(moss, "boredom", 0.5);
  moss.pursuit = { topic: "mending", title: "restore the old workshop clock", steps: 4, progress: 2, setbacks: 0, startedT: 0, lastStepT: 0 };
  noteExposure(moss, "craft:mended-thing", w.t);
  noteExposure(moss, "craft:mended-thing", w.t);
  noteExposure(moss, "craft:mended-thing", w.t);
  const { prompt } = buildDecisionPrompt(w, moss);
  assert.match(prompt, /low mood, tired/);
  assert.match(prompt, /lonely/);
  assert.match(prompt, /bored/);
  assert.match(prompt, /Your interests: mending/);
  assert.match(prompt, /restore the old workshop clock \(partway there/);
  assert.match(prompt, /Feels stale lately.*crafting mended things/);
  assert.ok(!/\b0\.\d/.test(prompt));
});

test("view exposes the two bars as levels and words, plus influences", () => {
  const w = fresh();
  const v = creatureView(w, w.creatures.pip);
  assert.ok(v.mood.level > 0 && typeof v.mood.word === "string");
  assert.ok(v.energy.level > 0 && typeof v.energy.word === "string");
  assert.ok(Array.isArray(v.influences) && Array.isArray(v.interests));
  assert.equal(v.pursuit, null);
});

test("an old saved world (drives, valence, arousal) migrates and keeps running", () => {
  const w = fresh();
  const old = JSON.parse(JSON.stringify(w));
  for (const c of Object.values(old.creatures) as any[]) {
    c.drives = { food: 0.3, energy: 0.5, social: 0.2, curiosity: 0.9, comfort: 0.6 };
    c.affect = { valence: 0.4, arousal: 0.3 };
    c.mood = 0.1;
    c.baseline = 0.2;
    for (const k of ["influences", "familiarity", "interests", "pursuit", "lastPursuitEndT", "received", "energy"]) delete c[k];
  }
  delete old.board;
  delete old.boardSeq;
  const m = migrate(old as World);
  const moss = m.creatures.moss;
  assert.equal((moss as any).drives, undefined);
  assert.equal((moss as any).affect, undefined);
  assert.ok(Math.abs(moss.energy - 0.5) < 1e-9);
  assert.ok(Math.abs(needLevel(moss, "hunger") - 0.7) < 1e-9);
  assert.ok(Math.abs(needLevel(moss, "loneliness") - 0.8) < 1e-9);
  assert.ok(Math.abs(needLevel(moss, "boredom") - 0.1) < 1e-9);
  assert.ok(moss.mood > 0.5 && moss.mood < 0.8);
  assert.deepEqual(moss.familiarity, {});
  assert.equal(moss.pursuit, null);
  assert.deepEqual(moss.received, []);
  assert.deepEqual(m.board, []);
  migrate(m); // idempotent
  assert.equal(m.creatures.moss.influences.filter((i) => i.kind === "hunger").length, 1);
  run(m, 288 * 2);
  for (const c of Object.values(m.creatures)) assert.ok(c.mood >= MOOD_FLOOR && c.energy >= ENERGY_FLOOR);
  assert.ok(creatureView(m, m.creatures.moss).influences.length >= 0);
});

test("pursuits: a strong interest becomes a project that can finish with a payoff", () => {
  const w = fresh();
  const moss = w.creatures.moss;
  moss.interests = [{ topic: "mending", strength: 0.9, t: w.t }];
  let finished = false;
  let started = false;
  for (let i = 0; i < 288 * 6 && !finished; i++) {
    for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
    if (moss.pursuit) started = true;
    if (started && !moss.pursuit && moss.influences.some((x) => x.kind === "accomplishment" && x.source.startsWith("finished"))) finished = true;
  }
  assert.ok(started, "a project should start");
  assert.ok(finished, "and finish with an accomplishment influence");
  assert.ok(moss.interests.length <= 4);
});

test("ten simulated days in rules mode: variety, selling, no hoarding, no starvation", () => {
  const w = fresh();
  const kinds: Record<string, Set<string>[]> = {};
  const counts: Record<string, Record<string, number>> = {};
  const last = new Map<string, unknown>();
  let maxHunger = 0;
  let peak = 0;
  for (let i = 0; i < 288 * 10; i++) {
    for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
    const day = Math.floor(w.t / 1440);
    for (const c of Object.values(w.creatures)) {
      const k = ((kinds[c.id] ??= [])[day] ??= new Set());
      if (c.activity && last.get(c.id) !== c.activity) {
        last.set(c.id, c.activity);
        const n = (counts[c.id] ??= {});
        n[c.activity.kind] = (n[c.activity.kind] ?? 0) + 1;
        if (!["walk", "sleep", "buy_food", "eat", "wait"].includes(c.activity.kind)) k.add(c.activity.kind + (c.activity.kind === "play" ? c.place : ""));
      }
      maxHunger = Math.max(maxHunger, needLevel(c, "hunger"));
      peak = Math.max(peak, c.inventory.length);
    }
  }
  assert.ok(maxHunger < 0.88, `max hunger ${maxHunger}`);
  assert.ok(peak <= 6, `peak items ${peak}`);
  for (const [id, n] of Object.entries(counts)) {
    assert.ok((n.sell ?? 0) >= 0.5 * (n.craft ?? 1), `${id} sells ${n.sell} vs crafts ${n.craft}`);
    const days = kinds[id].filter(Boolean);
    const avg = days.reduce((a, s) => a + s.size, 0) / days.length;
    assert.ok(avg >= 4, `${id} distinct activities per day ${avg}`);
  }
});
