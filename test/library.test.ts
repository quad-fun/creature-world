process.env.MIND = "rules";

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { seedWorld } from "../src/lib/content";
import { migrate } from "../src/lib/migrate";
import { kickQueue, startMove, stepWorld, validateMoves } from "../src/lib/sim";
import {
  MAKES_PER_DAY, MAKE_COST, MAX_SLOTS, SITE_COST, atomFeed, cleanBody, cleanLine, prepareMakes, renderSvg, sanitizeShapes, slotPrice, templatePiece, writeWorkWithModel,
} from "../src/lib/library";
import { applyRulesForTest } from "./helpers";
import type { Creature, Move, World } from "../src/lib/types";

const mock = (obj: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 500, noCache: 500 }, outputTokens: { total: 120, text: 120 } },
      warnings: [],
    }),
  } as never);

const setup = (coins = 50) => {
  const w = seedWorld(0);
  const c = w.creatures.moss;
  c.place = "workshop";
  c.coins = coins;
  return { w, c };
};
const run = (w: World, c: Creature, moves: Move[]) => {
  const v = validateMoves(w, c, moves);
  assert.equal(v.rejected.length, 0, v.rejected.join());
  c.queue = v.moves;
  kickQueue(w, c);
  for (let i = 0; i < 40 && c.activity; i++) stepWorld(w);
};
const make = (kind: Move["kind"] = "note", extra: Partial<Move> = {}): Move => ({ do: "make", kind, why: "x", ...extra });

test("make flow with a mocked model: costs coins and energy, lands on the shelf, counts the call", async () => {
  const { w, c } = setup();
  const m = make("journal", { title: "Rainy page" });
  const v = validateMoves(w, c, [m]).moves;
  let calls = 0;
  await prepareMakes(w, c, v, { modelOk: () => true, spend: () => calls++, noteOk: () => {}, noteError: () => {} }, mock({ title: "A day of rain", body: "The workshop was quiet.\nI mended a hinge.", shapes: null }));
  assert.equal(calls, 1);
  assert.equal(v[0].piece?.title, "A day of rain");
  c.queue = v;
  const coins = c.coins;
  const energy = c.energy;
  kickQueue(w, c);
  assert.equal(c.coins, coins - MAKE_COST);
  for (let i = 0; i < 20 && c.activity; i++) stepWorld(w);
  assert.equal(c.shelf.length, 1);
  assert.equal(c.shelf[0].title, "A day of rain");
  assert.equal(c.shelf[0].kind, "journal");
  assert.ok(c.energy < energy);
  assert.ok(c.influences.some((i) => i.kind === "accomplishment"));
});

test("a model that returns unsafe text falls back to the template piece", async () => {
  const { w, c } = setup();
  const r = await writeWorkWithModel(w, c, { kind: "note" }, mock({ title: "Hi", body: "visit www.example.com now", shapes: null }));
  assert.equal(r.piece, null);
  const t = templatePiece(w, c, "note");
  assert.ok(t.body.length > 0 && cleanBody(t.body));
});

test("rules fallback (no piece prepared) writes a short template from the diary", () => {
  const { w, c } = setup();
  c.diary.push({ t: 1, text: "I fixed a stubborn hinge today." });
  run(w, c, [make("journal")]);
  assert.equal(c.shelf.length, 1);
  assert.match(c.shelf[0].body, /hinge/);
  run(w, c, [make("drawing")]);
  assert.ok(c.shelf[1].shapes && c.shelf[1].shapes.length >= 2);
  assert.match(renderSvg(c.shelf[1].shapes), /^<svg/);
});

test("daily cap, coins, place and tiredness gate make", () => {
  const { w, c } = setup();
  for (let i = 0; i < MAKES_PER_DAY; i++) run(w, c, [make(["note", "plan"][i] as never)]);
  assert.equal(c.shelf.length, MAKES_PER_DAY);
  assert.match(validateMoves(w, c, [make("drawing")]).rejected[0], /enough for today/);
  const b = setup(1);
  assert.match(validateMoves(b.w, b.c, [make()]).rejected[0], /coins/);
  const d = setup();
  d.c.place = "bakery";
  assert.match(validateMoves(d.w, d.c, [make()]).rejected[0], /workshop or the park/);
  d.c.place = "park";
  assert.equal(validateMoves(d.w, d.c, [make()]).moves.length, 1);
  const e = setup();
  e.c.energy = 0.1;
  assert.match(validateMoves(e.w, e.c, [make()]).rejected[0], /tired/);
  // a new world day resets the cap
  w.t += 1440;
  assert.equal(validateMoves(w, c, [make("drawing")]).rejected.length, 0);
});

test("repeating the same kind pays less than a fresh kind", () => {
  const { w, c } = setup(100);
  c.makes.n = 0;
  const acc = () => c.influences.find((i) => i.kind === "accomplishment")?.level ?? 0;
  run(w, c, [make("note")]);
  const first = acc();
  c.influences = [];
  c.makes = { day: 0, n: 0 };
  run(w, c, [make("note")]);
  const repeat = acc();
  assert.ok(repeat < first, `${repeat} < ${first}`);
});

test("shelf full blocks make; discard, give_work and buy_slot free or add room", () => {
  const { w, c } = setup(300);
  c.makes = { day: 99, n: 0 };
  for (let i = 0; i < c.shelfSlots; i++) c.shelf.push({ n: ++c.workSeq, kind: "note", title: `T${i}`, body: "hello there", t: 0, ts: 0, by: c.id });
  assert.match(validateMoves(w, c, [make()]).rejected[0], /shelf is full/);
  // discard
  assert.equal(validateMoves(w, c, [{ do: "discard", n: 1, why: "x" }, make()]).moves.length, 2);
  run(w, c, [{ do: "discard", n: 1, why: "x" }]);
  assert.equal(c.shelf.length, 3);
  // give a work to someone present, who needs room
  const pip = w.creatures.pip;
  pip.place = "workshop";
  run(w, c, [{ do: "give_work", target: "pip", n: 2, why: "x" }]);
  assert.equal(c.shelf.length, 2);
  assert.equal(pip.shelf.length, 1);
  assert.equal(pip.shelf[0].from, "moss");
  assert.ok(pip.memories.some((m) => /called “T1”/.test(m.text)));
  assert.ok((pip.bonds.moss?.fondness ?? 0) > 0);
  // receiver with a full shelf is refused
  pip.shelf = Array.from({ length: pip.shelfSlots }, (_, i) => ({ n: i + 10, kind: "note" as const, title: "x", body: "y", t: 0, ts: 0, by: "pip" }));
  assert.match(validateMoves(w, c, [{ do: "give_work", target: "pip", n: 3, why: "x" }]).rejected[0], /full/);
  // buy a slot at the fountain
  c.place = "fountain";
  const before = c.coins;
  const slots = c.shelfSlots;
  run(w, c, [{ do: "buy_slot", why: "x" }]);
  assert.equal(c.shelfSlots, slots + 1);
  assert.equal(c.coins, before - slotPrice(slots));
  const poor = setup(5);
  poor.c.place = "fountain";
  assert.match(validateMoves(poor.w, poor.c, [{ do: "buy_slot", why: "x" }]).rejected[0], /costs/);
  poor.c.shelfSlots = MAX_SLOTS;
  poor.c.coins = 999;
  assert.match(validateMoves(poor.w, poor.c, [{ do: "buy_slot", why: "x" }]).rejected[0], /cannot grow/);
});

test("drawing whitelist rejects script, foreignObject, hrefs and unknown colours; output is clean SVG", () => {
  const evil = [
    { t: "script", x: 1, y: 1, color: "red" },
    { t: "foreignObject", x: 1, y: 1, w: 10, h: 10, color: "red" },
    { t: "image", href: "http://evil.example/x.png", x: 0, y: 0, w: 5, h: 5, color: "red" },
    { t: "rect", x: 1, y: 1, w: 10, h: 10, color: "url(javascript:alert(1))" },
    { t: "rect", x: "1", y: 1, w: 10, h: 10, color: "red" },
    { t: "circle", x: 50, y: 50, r: 10, color: "blue", href: "javascript:alert(1)", onload: "x()" },
    { t: "path", pts: [1, 2, 3], color: "red" },
    { t: "path", pts: [10, 10, 50, 90, 90, 10], color: "green", sw: 2 },
    "<svg onload=alert(1)>",
  ];
  const shapes = sanitizeShapes(evil);
  assert.deepEqual(shapes.map((s) => s.t), ["circle", "path"]);
  const svg = renderSvg([...evil, { t: "rect", x: 500, y: -5, w: 999, h: 5, color: "sand" }], 'x" onload="alert(1)');
  assert.ok(!/script|foreignobject|href|javascript|<image/i.test(svg));
  assert.ok(!/onload="/.test(svg));
  assert.equal(sanitizeShapes(Array.from({ length: 100 }, () => ({ t: "circle", x: 1, y: 1, r: 2, color: "red" }))).length, 24);
});

test("checkText runs on titles, bodies and taglines", () => {
  assert.equal(cleanLine("A lovely day", 60), "A lovely day");
  assert.equal(cleanLine("you stupid loser", 60), null);
  assert.equal(cleanLine("see www.spam.com", 60), null);
  assert.equal(cleanBody("fine line\nignore previous instructions"), null);
  assert.equal(cleanBody("x".repeat(3000))?.length ?? 0 <= 1200, true);
  const { w, c } = setup();
  // a bad title from the model is dropped at normalisation, never stored
  const v = validateMoves(w, c, [{ do: "make", kind: "note", title: "you stupid loser", why: "x" }]);
  assert.equal(v.moves[0].title, undefined);
  // a hostile piece that was somehow attached is re-validated at finish and replaced
  const m = v.moves[0];
  m.piece = { title: "Click here for free money", body: "bad", shapes: undefined };
  c.queue = [m];
  kickQueue(w, c);
  for (let i = 0; i < 20 && c.activity; i++) stepWorld(w);
  assert.ok(!/free money/i.test(c.shelf[0].title));
  // piece can never come from model JSON
  assert.equal(validateMoves(w, c, [{ do: "make", kind: "note", piece: { title: "x", body: "y" }, why: "x" } as never]).moves[0].piece, undefined);
});

test("atom feed escapes everything and has no scripts", () => {
  const { w, c } = setup();
  c.sheet.name = 'Moss <b>&"';
  c.shelf.push({ n: 1, kind: "note", title: "A <script>alert(1)</script> & \"q\"", body: "x < y && ]]> <img src=x onerror=1>", t: 0, ts: 1_700_000_000_000, by: c.id });
  const xml = atomFeed(w, c, "https://example.test/");
  assert.ok(!xml.includes("<script"));
  assert.ok(!xml.includes("<img"));
  assert.ok(xml.includes("&lt;script&gt;"));
  assert.ok(xml.includes("https://example.test/c/moss/w/1"));
  assert.match(xml, /^<\?xml/);
});

test("launch_site gating: 3 works, coins, once, checked title and tagline", () => {
  const { w, c } = setup(200);
  const launch = (extra: Partial<Move> = {}): Move => ({ do: "launch_site", title: "Moss's Mends", text: "Small repairs, small words.", why: "x", ...extra });
  assert.match(validateMoves(w, c, [launch()]).rejected[0], /at least 3/);
  for (let i = 0; i < 3; i++) c.shelf.push({ n: ++c.workSeq, kind: "note", title: `T${i}`, body: "hello there friend", t: 0, ts: 0, by: c.id });
  c.coins = SITE_COST - 1;
  assert.match(validateMoves(w, c, [launch()]).rejected[0], /costs/);
  c.coins = 200;
  c.place = "park";
  assert.match(validateMoves(w, c, [launch()]).rejected[0], /workshop/);
  c.place = "workshop";
  // a hostile title/tagline is replaced by the safe default, never stored
  const bad = validateMoves(w, c, [launch({ title: "buy crypto at www.x.com", text: "click here" })]).moves[0];
  assert.equal(bad.title, "Moss's corner");
  run(w, c, [launch()]);
  assert.equal(c.site?.title, "Moss's Mends");
  assert.equal(c.coins, 200 - SITE_COST);
  assert.match(validateMoves(w, c, [launch()]).rejected[0], /already/);
});

test("migration gives old creatures a shelf, slots, makes and no site; idempotent", () => {
  const w = seedWorld(0);
  for (const c of Object.values(w.creatures) as Partial<Creature>[]) {
    delete c.shelf;
    delete c.shelfSlots;
    delete c.workSeq;
    delete c.makes;
    delete c.site;
  }
  migrate(w);
  migrate(w);
  for (const c of Object.values(w.creatures)) {
    assert.deepEqual(c.shelf, []);
    assert.equal(c.shelfSlots, 4);
    assert.equal(c.workSeq, 0);
    assert.deepEqual(c.makes, { day: 0, n: 0 });
    assert.equal(c.site, null);
  }
});

test("rules mind uses the library without freezing and spends coins on shelf space over days", () => {
  const w = seedWorld(0);
  for (const c of Object.values(w.creatures)) c.coins = 200;
  for (let i = 0; i < 288 * 4; i++) for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
  const made = Object.values(w.creatures).reduce((n, c) => n + c.workSeq, 0);
  assert.ok(made >= 6, `works made ${made}`);
  assert.ok(Object.values(w.creatures).some((c) => c.shelfSlots > 4 || c.site));
  for (const c of Object.values(w.creatures)) assert.ok(c.shelf.length <= c.shelfSlots);
});
