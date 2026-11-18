process.env.MIND = "rules";
process.env.CRON_SECRET = "";

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { seedWorld } from "../src/lib/content";
import { migrate } from "../src/lib/migrate";
import { applyInbox } from "../src/lib/inbox";
import { kickQueue, logFeed, normalizeMove, stepWorld, validateMoves } from "../src/lib/sim";
import {
  CREATION_COST, CREATION_PENDING_LIFETIME, JOY_EVENTS_PER_DAY, MAX_LIVE_PER_KIND, MAX_PENDING_CREATIONS, PLAYS_PER_CREATION_DAY, PLAYS_PER_IP_DAY,
  adminCreationAct, adminCreations, applyCreationPlay, bandOf, creationsOf, findCreation, normalizeGame, normalizeSteps, parseAnswers, publicCreation, publicCreations, resultLine, scoreGame, sweepCreations,
} from "../src/lib/creations";
import { utcDayStr } from "../src/lib/shops";
import { applyRulesForTest } from "./helpers";
import { buildDecisionPrompt } from "../src/lib/mind";
import { getStore } from "../src/lib/store";
import { activeInfluences } from "../src/lib/affect";
import { GET as adminGet, POST as adminPost } from "../src/app/api/admin/creations/route";
import { POST as answerPost } from "../src/app/api/game/answer/route";
import { POST as listenPost } from "../src/app/api/listen/route";
import { GET as tuneGet } from "../src/app/api/tune/[id]/route";
import type { Creature, InboxItem, Move, Question, World } from "../src/lib/types";

const act = (...a: Parameters<typeof adminCreationAct>) => adminCreationAct(...a) as { ok: boolean; status?: number; message?: string; error?: string };
const Q = (prompt = "What do bees make?", options = ["Honey", "Bread", "Rain"], correct = 0) => ({ prompt, options, correct });
const GAME = () => ({ questions: [Q(), Q("Which animal says quack?", ["A duck", "A cat"], 0), Q("How many days are in a week?", ["Five", "Seven", "Ten", "Nine"], 1)], results: ["Try again.", "Nice.", "Great!"] });
const TUNE = (m: Partial<Move> = {}): Partial<Move> => ({ do: "compose", title: "Pond song", steps: ["C4", "E4", "rest", "G4", "C5", "rest", "G4", "E4"], tempo: 110, instrument: "triangle", ...m });
const setup = () => {
  const w = seedWorld(0);
  const c = w.creatures.moss;
  c.place = "workshop";
  c.coins = 40;
  c.energy = 0.9;
  c.site = { title: "Moss's corner", tagline: "Things I made.", t: 0 };
  return { w, c };
};
const make = (w: World, c: Creature, m: Partial<Move> = {}) => {
  const v = validateMoves(w, c, [{ do: "make_game", why: "x", title: "Bee quiz", game: GAME(), ...m } as Move]);
  if (v.rejected.length) return { err: v.rejected.join() };
  c.queue = v.moves;
  kickQueue(w, c);
  for (let i = 0; i < 20 && c.activity; i++) stepWorld(w);
  return { err: null };
};
const makeGame = (w: World, c: Creature) => {
  assert.equal(make(w, c).err, null);
  const x = w.creations.at(-1)!;
  assert.equal(act(w, "approve", x.id, logFeed).ok, true);
  return x;
};
const makeTune = (w: World, c: Creature, m: Partial<Move> = {}) => {
  const r = make(w, c, TUNE(m));
  return r.err ? null : w.creations.at(-1)!;
};
let seq = 0;
const play = (id: number, extra: Partial<InboxItem> = {}): InboxItem => ({ type: "creation_play", id, token: (++seq).toString(16).padStart(12, "0"), ...extra }) as InboxItem;
const NOW = Date.UTC(2026, 5, 1, 12);
const rip = () => `5.5.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

test("game validation: 3 to 5 questions, 2 to 4 options, exactly one correct index, plain filtered text", () => {
  assert.ok(normalizeGame(GAME()));
  const bad = (f: (g: ReturnType<typeof GAME>) => unknown) => {
    const g = GAME();
    assert.equal(normalizeGame(f(g)), null);
  };
  bad((g) => ({ ...g, questions: g.questions.slice(0, 2) }));
  bad((g) => ({ ...g, questions: [...g.questions, Q(), Q(), Q()] }));
  bad((g) => ((g.questions[0].options = ["Only"]), g));
  bad((g) => ((g.questions[0].options = ["a", "b", "c", "d", "e"]), g));
  bad((g) => ((g.questions[0].correct = 3), g));
  bad((g) => ((g.questions[0].correct = -1), g));
  bad((g) => ((g.questions[0].correct = 0.5), g));
  bad((g) => (((g.questions[0] as { correct: unknown }).correct = "0"), g));
  bad((g) => (((g.questions[0] as { correct: unknown }).correct = [0, 1]), g));
  bad((g) => ((g.questions[0].options = ["Same", "same", "Other"]), g)); // duplicates: "exactly one" would be meaningless
  bad((g) => ((g.questions[0].prompt = "x".repeat(101)), g));
  bad((g) => ((g.questions[0].options[0] = "y".repeat(41)), g));
  bad((g) => ((g.questions[0].prompt = "<b>bold</b>"), g));
  bad((g) => ((g.questions[0].prompt = "See http://evil.example"), g));
  bad((g) => ((g.questions[0].options[1] = "Café а"), g));
  bad((g) => ((g.results[0] = "z".repeat(81)), g));
  bad((g) => ({ ...g, results: ["a", "b", "c", "d"] }));
  bad((g) => ({ ...g, results: "nope" }));
  bad((g) => ({ ...g, questions: "x" }));
  assert.equal(normalizeGame(null), null);
  assert.equal(normalizeGame([]), null);
  assert.deepEqual(normalizeGame({ questions: GAME().questions })!.results, ["", "", ""], "results are optional");
  assert.deepEqual(normalizeGame({ ...GAME(), results: ["Low", null, ""] })!.results, ["Low", "", ""]);
  // unkind words are refused by the filter
  const g = GAME();
  g.questions[0].prompt = "You are all idiots, right?";
  assert.equal(normalizeGame(g), null);
});

test("hostile JSON and __proto__ keys never pollute or smuggle fields", () => {
  const evil = JSON.parse(`{"questions":[{"prompt":"Hi there","options":["a1","b2"],"correct":0,"__proto__":{"polluted":true},"constructor":{"x":1}},{"prompt":"Hi again","options":["c3","d4"],"correct":1},{"prompt":"Hi too","options":["e5","f6"],"correct":0}],"results":[],"__proto__":{"isAdmin":true}}`);
  const g = normalizeGame(evil)!;
  assert.ok(g);
  assert.deepEqual(Object.keys(g.questions[0]).sort(), ["correct", "options", "prompt"]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
  const { w, c } = setup();
  const m = normalizeMove(w, JSON.parse(`{"do":"make_game","why":"w","title":"Hello","game":{"__proto__":{"questions":[]},"questions":"x"}}`))!;
  assert.equal(m.game, undefined);
  assert.match(validateMoves(w, c, [m]).rejected.join(), /questions/);
  const t = normalizeMove(w, { do: "compose", why: "w", title: "T", steps: ["C4", "__proto__", "E4", "G4"], tempo: "110", instrument: "constructor" })!;
  assert.equal(t.steps, undefined);
  assert.equal(t.tempo, undefined);
  assert.equal(t.instrument, undefined);
  // lookups by outside strings never resolve prototype names
  assert.equal(findCreation(w, "__proto__"), undefined);
  assert.equal(findCreation(w, "constructor"), undefined);
  assert.equal(findCreation(w, { toString: 1 }), undefined);
  assert.equal(parseAnswers("__proto__", GAME().questions), null);
});

test("tune validation: note, tempo and instrument whitelists, 16 step bound", () => {
  assert.ok(normalizeSteps(["C4", "D4", "rest", "B5"]));
  assert.deepEqual(normalizeSteps(["c4", "d4", "-", "Rest"]), ["C4", "D4", "rest", "rest"].slice(0, 2).concat(["rest", "rest"]).length === 4 ? ["C4", "D4", "rest", "rest"] : null);
  for (const s of [["C4", "D4", "E4"], Array(17).fill("C4"), ["C4", "D4", "E4", "C#4"], ["C4", "D4", "E4", "C6"], ["C4", "D4", "E4", "B3"], ["C4", "D4", "E4", 5], ["C4", "D4", "E4", "<b>"], ["rest", "rest", "rest", "C4"], "C4", null, {}]) {
    assert.equal(normalizeSteps(s), null, JSON.stringify(s));
  }
  assert.equal(normalizeSteps(Array(16).fill("E5"))!.length, 16);
  const { w, c } = setup();
  const bad = (m: Partial<Move>, re: RegExp) => {
    const r = make(w, c, TUNE(m));
    assert.match(r.err ?? "", re);
  };
  bad({ tempo: 100 }, /tempo/);
  bad({ tempo: undefined }, /tempo/);
  bad({ instrument: "organ" }, /instrument/);
  bad({ title: "x".repeat(41) }, /title/);
  bad({ title: "" }, /title/);
  bad({ title: "Visit www.x.com" }, /title/);
  assert.equal(w.creations.length, 0);
  assert.ok(makeTune(w, c), "a good one goes through");
});

test("a creature needs the workshop, a site, energy, coins and a free day; costs coins and energy", () => {
  const { w, c } = setup();
  const bad = (m: Partial<Move>, re: RegExp) => assert.match(make(w, c, m).err ?? "", re);
  c.site = null;
  bad({}, /website/);
  c.site = { title: "x", tagline: "y", t: 0 };
  c.place = "park";
  bad({}, /workshop/);
  c.place = "workshop";
  c.energy = 0.2;
  bad({}, /tired/);
  c.energy = 0.9;
  c.coins = CREATION_COST - 1;
  bad({}, /coins/);
  c.coins = 20;
  const e0 = c.energy;
  assert.equal(make(w, c).err, null);
  assert.equal(c.coins, 20 - CREATION_COST);
  assert.ok(c.energy < e0);
  assert.equal(w.creations.length, 1);
  assert.equal(w.creations[0].status, "pending");
  assert.equal(publicCreations(w).length, 0, "invisible until approved");
  assert.ok(activeInfluences(c).some((i) => i.kind === "accomplishment"), "small accomplishment on creation");
  assert.ok(w.feed.some((f) => /quiz/.test(f.text)));
  // one creation per creature per world day, and one of each kind per creature
  bad({}, /today/);
  w.t += 1440;
  bad({}, /already have a game/);
  assert.ok(makeTune(w, c), "a tune is a different kind: allowed on a later day");
  w.t += 1440;
  assert.match(make(w, c, TUNE()).err ?? "", /already have a tune/);
});

test("caps: 3 live per kind, 6 pending, one of each per creature, approval past the cap refused", () => {
  const w = seedWorld(0);
  for (const n of ["a1", "a2", "a3"]) {
    const k = structuredClone(w.creatures.moss);
    k.id = n;
    k.sheet.name = n;
    w.creatures[n] = k;
  }
  const ids = Object.keys(w.creatures);
  assert.ok(ids.length >= 6);
  for (const id of ids) {
    const c = w.creatures[id];
    c.place = "workshop"; c.coins = 40; c.energy = 0.9; c.site = { title: "s", tagline: "t", t: 0 };
  }
  let made = 0;
  for (const id of ids) {
    const c = w.creatures[id];
    if (!make(w, c).err) made++;
  }
  assert.equal(made, 6);
  assert.equal(w.creations.filter((x) => x.status === "pending").length, 6);
  // a seventh creation (a tune) is refused while 6 wait
  const c0 = w.creatures[ids[0]];
  w.t += 1440;
  assert.match(make(w, c0, TUNE()).err ?? "", /waiting/);
  const gameIds = w.creations.map((x) => x.id);
  for (let i = 0; i < MAX_LIVE_PER_KIND; i++) assert.equal(act(w, "approve", gameIds[i], logFeed).ok, true);
  const over = act(w, "approve", gameIds[3], logFeed);
  assert.equal(over.status, 409);
  assert.match(over.error ?? "", /cap/);
  assert.equal(w.creations.filter((x) => x.status === "live").length, 3);
  assert.equal(MAX_PENDING_CREATIONS, 6);
});

test("approve, reject (refund once), remove (no refund), bad input", () => {
  const { w, c } = setup();
  assert.equal(make(w, c).err, null);
  const id = w.creations[0].id;
  const coins = c.coins;
  assert.equal(act(w, "approve", "1", logFeed).status, 400);
  assert.equal(act(w, "approve", 1.5, logFeed).status, 400);
  assert.equal(act(w, "explode", id, logFeed).status, 400);
  assert.equal(act(w, "approve", 999, logFeed).status, 404);
  assert.equal(act(w, "remove", id, logFeed).status, 409, "remove needs a live one");
  assert.equal(act(w, "reject", id, logFeed).message, "rejected and refunded");
  assert.equal(c.coins, coins + CREATION_COST);
  assert.equal(act(w, "reject", id, logFeed).status, 404, "no double refund");
  assert.equal(c.coins, coins + CREATION_COST);
  w.t += 1440;
  const x = makeGame(w, c);
  assert.equal(act(w, "approve", x.id, logFeed).status, 409);
  assert.equal(act(w, "reject", x.id, logFeed).status, 409, "a live one cannot be rejected for a refund");
  const c2 = c.coins;
  assert.equal(act(w, "remove", x.id, logFeed).ok, true);
  assert.equal(c.coins, c2, "a creation that stood is not refunded");
  assert.equal(w.creations.length, 0);
});

test("unanswered creations lapse after 3 world days with a refund", () => {
  const { w, c } = setup();
  assert.equal(make(w, c).err, null);
  const coins = c.coins;
  w.t = w.creations[0].createdT + CREATION_PENDING_LIFETIME - 60;
  sweepCreations(w);
  assert.equal(w.creations.length, 1);
  w.t += 60;
  sweepCreations(w);
  assert.equal(w.creations.length, 0);
  assert.equal(c.coins, coins + CREATION_COST);
  // a live one never lapses
  const x = makeGame(w, c);
  w.t += 10 * 1440;
  sweepCreations(w);
  assert.equal(w.creations.length, 1);
  assert.equal(x.status, "live");
});

test("play flow: stateless answers, server-side scoring, result bands", () => {
  const g = normalizeGame(GAME())!;
  const qs: Question[] = g.questions;
  assert.deepEqual(parseAnswers("", qs), []);
  assert.deepEqual(parseAnswers("01", qs), [0, 1]);
  assert.deepEqual(parseAnswers("011", qs), [0, 1, 1]);
  for (const bad of ["0111", "3", "9", "-1", "a", "0 1", "1.5", " 0", 5, {}, ["0"], "00000"]) assert.equal(parseAnswers(bad, qs), null, String(bad));
  assert.equal(scoreGame(qs, [0, 0, 1]), 3);
  assert.equal(scoreGame(qs, [1, 1, 0]), 0);
  assert.equal(scoreGame(qs, [0, 1, 1]), 2);
  assert.equal(bandOf(0, 3), 0);
  assert.equal(bandOf(2, 3), 1);
  assert.equal(bandOf(3, 3), 2);
  assert.equal(resultLine(g.results, 3, 3), "Great!");
  assert.equal(resultLine(["", "", ""], 3, 3).length > 0, true, "default line when none given");
  // the page source never puts the answer key into HTML
  const page = readFileSync("src/app/play/[id]/page.tsx", "utf8");
  assert.ok(!/\.correct/.test(page), "page never reads the correct index");
  assert.ok(!/<script/i.test(page));
});

test("answer route: scoring on the server, bad bodies, replay and rate limits", async () => {
  const store = getStore();
  const { w, c } = setup();
  const x = makeGame(w, c);
  await store.save(w);
  await store.drainInbox();
  const post = (body: unknown, ip: string, raw?: string, type = "application/json") =>
    answerPost(new Request("http://x/api/game/answer", { method: "POST", headers: { "content-type": type, "x-forwarded-for": ip }, body: raw ?? JSON.stringify(body) }));
  const ip = rip();
  const r = await post({ game: x.id, a: "001" }, ip);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual([j.score, j.of, j.counted], [3, 3, true]);
  assert.equal(j.message, "Great!");
  // double submit from the same visitor straight away: score still shown, but not counted twice
  const again = await (await post({ game: x.id, a: "001" }, ip)).json();
  assert.equal(again.score, 3);
  assert.equal(again.counted, false);
  const inbox = await store.drainInbox();
  assert.equal(inbox.length, 1);
  assert.equal((inbox[0] as { score: number }).score, 3);
  // the client cannot claim a score: the body has no score field that is read
  const ip2 = rip();
  const cheat = await (await post({ game: x.id, a: "110", score: 3 }, ip2)).json();
  assert.equal(cheat.score, 0);
  await store.drainInbox();
  // hostile bodies
  const ip3 = rip();
  for (const [body, raw] of [[null, "nope"], [null, "[]"], [{ game: "1", a: "001" }], [{ game: x.id, a: "00" }], [{ game: x.id, a: "0012" }], [{ game: x.id, a: "009" }], [{ game: x.id, a: 1 }], [{ game: x.id, a: ["0"] }], [{ game: 1.5, a: "001" }], [{ game: 999, a: "001" }], [{ game: -1, a: "001" }], [{ game: "__proto__", a: "001" }]] as [unknown, string | undefined][]) {
    const s = (await post(body, ip3, raw)).status;
    assert.ok([400, 404].includes(s), `${raw ?? JSON.stringify(body)} -> ${s}`);
  }
  assert.equal((await post(null, ip3, "x".repeat(9000))).status, 400);
  // a form post is redirected to the result page, never echoing hostile input
  const f = await post(null, rip(), `game=${x.id}&a=00&n=1`, "application/x-www-form-urlencoded");
  assert.equal(f.status, 303);
  assert.match(f.headers.get("location") ?? "", new RegExp(`/play/${x.id}\\?a=001$`));
  const fb = await post(null, rip(), `game=${x.id}&a=%3Cscript%3E&n=1`, "application/x-www-form-urlencoded");
  assert.equal(fb.status, 400);
  await store.drainInbox();
  // per-IP daily limit: the score is still shown, the play stops counting
  const ip4 = rip();
  const counted: boolean[] = [];
  for (let i = 0; i < PLAYS_PER_IP_DAY + 2; i++) {
    await store.hit(`gplay2:${ip4}:${x.id}`, 1, -1).catch(() => 0); // (window keys are per call; the double-submit key is separate)
    counted.push(Boolean((await (await post({ game: x.id, a: "000" }, ip4)).json()).counted));
  }
  assert.ok(counted.filter(Boolean).length <= PLAYS_PER_IP_DAY);
  await store.drainInbox();
});

test("a counted play: small joy and accomplishment, feed line, habituated, capped, replay-safe", () => {
  const { w, c } = setup();
  const x = makeGame(w, c);
  const before = activeInfluences(c).filter((i) => i.kind === "joy").length;
  const it = play(x.id, { score: 2, of: 3 } as never);
  applyInbox(w, [it]);
  assert.equal(x.plays, 1);
  assert.ok(activeInfluences(c).some((i) => i.kind === "joy"));
  assert.ok(before === 0);
  assert.ok(w.feed.some((f) => /plays Moss's quiz “Bee quiz” and gets 2 of 3/.test(f.text)));
  // replay of the very same token changes nothing
  applyInbox(w, [it]);
  assert.equal(x.plays, 1);
  // forged score: ignored, not shown
  applyInbox(w, [play(x.id, { score: 99, of: 3 } as never)]);
  assert.ok(!w.feed.some((f) => /gets 99/.test(f.text)));
  // habituation: the same play pays less each time
  const joyAt = () => Math.max(0, ...activeInfluences(c).filter((i) => i.kind === "joy").map((i) => i.level));
  const c2 = setup().c;
  void c2;
  const w2 = setup();
  const x2 = makeGame(w2.w, w2.c);
  const lv: number[] = [];
  for (let i = 0; i < 2; i++) {
    w2.c.influences = w2.c.influences.filter((k) => k.kind !== "joy");
    applyInbox(w2.w, [play(x2.id)]);
    lv.push(Math.max(...activeInfluences(w2.c).filter((k) => k.kind === "joy").map((k) => k.level)));
  }
  assert.ok(lv[1] < lv[0], `habituated ${lv}`);
  void joyAt;
  // daily caps: per creation per real day, per creature per world day for feelings
  const w3 = setup();
  const x3 = makeGame(w3.w, w3.c);
  const coins = w3.c.coins;
  for (let i = 0; i < 20; i++) applyCreationPlay(w3.w, play(x3.id) as never, NOW);
  assert.equal(x3.plays, PLAYS_PER_CREATION_DAY);
  assert.equal(w3.c.creationJoy.n, JOY_EVENTS_PER_DAY);
  assert.equal(w3.c.coins, coins, "plays never give coins");
  applyCreationPlay(w3.w, play(x3.id) as never, NOW + 86400_000);
  assert.equal(x3.plays, PLAYS_PER_CREATION_DAY + 1, "next real day counts again");
  // plays on unknown, pending or non-live creations do nothing
  const w4 = setup();
  assert.equal(make(w4.w, w4.c).err, null);
  applyInbox(w4.w, [play(w4.w.creations[0].id), play(12345), play(1.5 as never), { type: "creation_play", id: 1, token: "bad" } as never, null as never]);
  assert.equal(w4.w.creations[0].plays, 0);
  assert.ok(w4.w.playTokens.length === 0);
});

test("tunes: stored as data, rendered from whitelisted values, listen counts like a play", () => {
  const { w, c } = setup();
  const t = makeTune(w, c)!;
  assert.ok(t);
  assert.equal(creationsOf(w, "moss").length, 0);
  assert.equal(act(w, "approve", t.id, logFeed).ok, true);
  const p = publicCreation(w, t)!;
  assert.deepEqual([p.tempo, p.instrument, p.steps!.length], [110, "triangle", 8]);
  applyInbox(w, [play(t.id)]);
  assert.equal(t.plays, 1);
  assert.ok(w.feed.some((f) => /listens to Moss's tune/.test(f.text)));
  assert.ok(activeInfluences(c).some((i) => i.kind === "joy"));
  assert.ok(!activeInfluences(c).some((i) => i.source === "my quiz was played"));
  // tampered stored data hides it
  t.steps![0] = "<img>";
  assert.equal(publicCreation(w, t), null);
  t.steps![0] = "C4";
  t.tempo = 999;
  assert.equal(publicCreation(w, t), null);
  t.tempo = 110;
  t.title = "<script>alert(1)</script>";
  assert.equal(publicCreation(w, t), null);
  t.title = "Fine";
  c.site = null;
  assert.equal(publicCreation(w, t), null, "needs the maker's site");
});

test("escaping and scripts: pages hold no creature text in JS, the only script is our same-origin file", () => {
  const files = ["src/app/creations-ui.tsx", "src/app/play/[id]/page.tsx", "src/app/creations/page.tsx", "src/app/s/[id]/page.tsx"].map((f) => readFileSync(f, "utf8")).join("\n");
  assert.equal((files.match(/dangerouslySetInnerHTML/g) ?? []).length, 1, "only the existing drawing SVG");
  assert.deepEqual(files.match(/<script[^>]*>/g), ['<script src="/tune.js" defer />']);
  assert.ok(!/href=\{?["']?https?:|src=\{?["']?https?:/.test(files), "no external links or images");
  assert.ok(!/on(click|load|error)=/i.test(files), "no inline handlers");
  const js = readFileSync("public/tune.js", "utf8");
  assert.ok(existsSync("public/tune.js"));
  assert.ok(!/\b(eval|Function\(|innerHTML|outerHTML|document\.write|fetch\(|XMLHttpRequest|WebSocket|import\(|location|cookie|localStorage|sendBeacon)\b/.test(js), "the player is static and offline");
  assert.ok(/TEMPOS\.indexOf\(tempo\) < 0 \|\| INSTR\.indexOf\(inst\) < 0/.test(js), "it re-checks its inputs against its own whitelists");
  // creature text never goes into data attributes: only whitelisted values do
  const ui = readFileSync("src/app/creations-ui.tsx", "utf8");
  assert.ok(/data-steps=\{steps\.join/.test(ui) && !/data-[a-z]+=\{t\.title/.test(ui));
});

test("tune JSON route: live tunes only, whitelisted fields, no prototype lookups", async () => {
  const store = getStore();
  const { w, c } = setup();
  const t = makeTune(w, c)!;
  await store.save(w);
  const get = (id: string) => tuneGet(new Request("http://x/api/tune/" + id), { params: Promise.resolve({ id }) });
  assert.equal((await get(String(t.id))).status, 404, "pending is not public");
  act(w, "approve", t.id, logFeed);
  await store.save(w);
  const r = await get(String(t.id));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ["by", "instrument", "steps", "tempo", "title"]);
  for (const id of ["__proto__", "constructor", "-1", "1.5", "abc", "99999999", ""]) assert.equal((await get(id)).status, 404, id);
});

test("listen route: form and JSON, rate limited, queues one counted play", async () => {
  const store = getStore();
  const { w, c } = setup();
  const t = makeTune(w, c)!;
  act(w, "approve", t.id, logFeed);
  await store.save(w);
  await store.drainInbox();
  const post = (ip: string, raw: string, type = "application/x-www-form-urlencoded") => listenPost(new Request("http://x/api/listen", { method: "POST", headers: { "content-type": type, "x-forwarded-for": ip }, body: raw }));
  const ip = rip();
  const f = await post(ip, `tune=${t.id}`);
  assert.equal(f.status, 303);
  assert.match(f.headers.get("location") ?? "", /\/s\/moss\?heard=1#tunes$/);
  const f2 = await post(ip, `tune=${t.id}`);
  assert.match(f2.headers.get("location") ?? "", /heard=0/, "double submit is not counted");
  assert.equal((await store.drainInbox()).length, 1);
  assert.equal((await post(rip(), "tune=abc")).status, 400);
  assert.equal((await post(rip(), "tune=999")).status, 404);
  assert.equal((await post(rip(), JSON.stringify({ tune: "1" }), "application/json")).status, 400);
  assert.equal((await post(rip(), "x".repeat(900))).status, 400);
});

test("admin creations route: 503 unset, 401 wrong, list, approve, reject, remove, busy", async () => {
  const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Request("http://x/api/admin/creations", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  delete process.env.ADMIN_SECRET;
  assert.equal((await adminGet(req("GET"))).status, 503);
  assert.equal((await adminPost(req("POST", {}, { action: "approve", id: 1 }))).status, 503);
  process.env.ADMIN_SECRET = "cr-secret";
  assert.equal((await adminGet(req("GET"))).status, 401);
  assert.equal((await adminGet(req("GET", { authorization: "Bearer nope" }))).status, 401);
  assert.equal((await adminPost(req("POST", {}, { action: "approve", id: 1 }))).status, 401);
  const store = getStore();
  const { w, c } = setup();
  assert.equal(make(w, c).err, null);
  await store.save(w);
  const auth = { authorization: "Bearer cr-secret" };
  const list = await (await adminGet(req("GET", auth))).json();
  assert.equal(list.creations.length, 1);
  assert.equal(list.creations[0].status, "pending");
  assert.equal(list.creations[0].questions.length, 3);
  const id = list.creations[0].id;
  assert.equal((await adminPost(req("POST", auth, { action: "explode", id }))).status, 400);
  assert.equal((await adminPost(req("POST", auth, { action: "approve", id: "1" }))).status, 400);
  assert.equal((await adminPost(req("POST", auth, { action: "approve", id: 999 }))).status, 404);
  assert.equal((await adminPost(req("POST", auth, { action: "approve", id }))).status, 200);
  assert.equal((await store.load())!.creations[0].status, "live");
  assert.equal(await store.lock(20), true);
  assert.equal((await adminPost(req("POST", auth, { action: "remove", id }))).status, 409);
  await store.unlock();
  assert.equal((await adminPost(req("POST", { "x-admin-secret": "cr-secret" }, { action: "remove", id }))).status, 200);
  assert.equal((await store.load())!.creations.length, 0);
  assert.equal(adminCreations(w).length, 1);
  delete process.env.ADMIN_SECRET;
});

test("migration: old worlds load with defaults; tampered creations are cleaned", () => {
  const w = seedWorld(0) as unknown as Record<string, unknown>;
  delete w.creations;
  delete w.creationSeq;
  delete w.playTokens;
  for (const c of Object.values(w.creatures as Record<string, Record<string, unknown>>)) {
    delete c.creationDay;
    delete c.creationJoy;
  }
  const m = migrate(w as unknown as World);
  assert.deepEqual([m.creations, m.creationSeq, m.playTokens], [[], 0, []]);
  assert.ok(Object.values(m.creatures).every((c) => c.creationDay === 0 && c.creationJoy.n === 0));
  const { w: w2, c } = setup();
  const g = makeGame(w2, c);
  w2.t += 1440;
  const tu = makeTune(w2, c)!;
  assert.ok(tu);
  w2.creations.push({ ...g, id: 77, title: "<b>x</b>" }, { ...g, id: 78, kind: "tune", questions: undefined } as never, null as never, { ...tu, id: 79, tempo: 5 });
  (w2 as unknown as Record<string, unknown>).playTokens = ["abcdef012345", "bad", 5];
  (g as unknown as Record<string, unknown>).paid = 9999;
  const m2 = migrate(JSON.parse(JSON.stringify(w2)));
  assert.deepEqual(m2.creations.map((x) => x.id).sort(), [g.id, tu.id].sort());
  assert.ok(m2.creations.every((x) => x.paid <= 10));
  assert.deepEqual(m2.playTokens, ["abcdef012345"]);
  assert.equal(m2.creationSeq >= tu.id, true);
  assert.deepEqual(migrate(structuredClone(m2)), m2, "idempotent");
});

test("the prompt lists the moves with their limits and the schema accepts them", () => {
  const { w, c } = setup();
  const p = buildDecisionPrompt(w, c).prompt;
  assert.match(p, /make_game/);
  assert.match(p, /compose/);
  assert.match(p, /max 40 plain characters/);
  assert.match(p, /3 to 5 of \{prompt/);
  assert.match(p, /approval/);
  const mind = readFileSync("src/lib/mind.ts", "utf8");
  assert.ok(/"make_game", "compose"/.test(mind));
});

test("creations add no model calls and no credits code", () => {
  for (const f of ["src/lib/creations.ts", "src/app/api/game/answer/route.ts", "src/app/api/listen/route.ts", "src/app/api/admin/creations/route.ts", "src/app/play/[id]/page.tsx", "src/app/creations/page.tsx"]) {
    const s = readFileSync(f, "utf8");
    assert.ok(!/from ["'][^"']*(credits|payment|x402|usdc|mind|appraise|ai)["']/i.test(s), f);
    assert.ok(!/generateText|generateObject|streamText/.test(s), f);
  }
});

test("rules mind makes things sometimes, only after a site, stays consistent for 10 days with approvals and visitors", () => {
  const w = seedWorld(0);
  for (const c of Object.values(w.creatures)) c.coins = 80;
  const startCoins = Object.values(w.creatures).reduce((n, c) => n + c.coins, 0);
  let games = 0, tunes = 0, plays = 0;
  const made = new Set<number>();
  for (let i = 0; i < 10 * 288; i++) {
    for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
    if (i % 24 === 0) for (const x of w.creations) if (x.status === "pending" && act(w, "approve", x.id, logFeed).ok) { /* a friendly human */ }
    if (i % 40 === 0) for (const x of w.creations) if (x.status === "live") {
      const before = w.feed.length;
      applyInbox(w, [play(x.id, x.kind === "game" ? ({ score: 1, of: 3 } as never) : {})]);
      if (w.feed.length > before) plays++;
    }
    for (const x of w.creations) {
      if (!made.has(x.id)) { made.add(x.id); x.kind === "game" ? games++ : tunes++; }
      const c = w.creatures[x.by];
      assert.ok(c.site, "only creatures with a site make things");
    }
    for (const c of Object.values(w.creatures)) assert.ok(c.coins >= 0 && Number.isInteger(c.coins));
    assert.ok(w.creations.filter((x) => x.status === "live" && x.kind === "game").length <= MAX_LIVE_PER_KIND);
    assert.ok(w.creations.filter((x) => x.status === "live" && x.kind === "tune").length <= MAX_LIVE_PER_KIND);
    assert.ok(w.creations.filter((x) => x.status === "pending").length <= MAX_PENDING_CREATIONS);
    for (const x of w.creations) assert.ok(publicCreation(w, { ...x, status: "live" }) !== null, "every rules-made creation validates");
  }
  const endCoins = Object.values(w.creatures).reduce((n, c) => n + c.coins, 0);
  console.log(`      creations: games ${games}, tunes ${tunes}, counted plays ${plays}, coins ${startCoins} -> ${endCoins}`);
  assert.ok(games + tunes >= 1, "the rules mind does make things");
  assert.ok(games + tunes <= 12);
  assert.ok(Object.values(w.creatures).every((c) => c.creationDay <= Math.floor(w.t / 1440) + 1));
  assert.equal(utcDayStr(NOW), "2026-06-01");
});
