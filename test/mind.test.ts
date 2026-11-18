import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { seedWorld } from "../src/lib/content";
import { decideWithModel, reflectWithModel } from "../src/lib/mind";
import { validateMoves } from "../src/lib/sim";

const NEW_MOVE_FIELDS = { kind: null, title: null, topic: null, n: null, build: null, listings: null };
const mockReturning = (obj: unknown) => {
  const o = obj as { moves?: object[] };
  if (o.moves) o.moves = o.moves.map((m) => ({ ...NEW_MOVE_FIELDS, ...m }));
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1200, noCache: 1200 }, outputTokens: { total: 90, text: 90 } },
      warnings: [],
    }),
  } as never);
};

test("model output is parsed, token usage is read, and the chain validates", async () => {
  const w = seedWorld(0);
  const c = w.creatures.moss;
  const model = mockReturning({
    goal: "  learn the bakery's habits  ",
    moves: [
      { do: "walk", place: "bakery", target: null, item: null, text: null, why: "Hungry." },
      { do: "buy_food", place: null, target: null, item: null, text: null, why: "Bread." },
      { do: "eat", place: null, target: null, item: "bread", text: null, why: "Now." },
    ],
  });
  const r = await decideWithModel(w, c, model);
  assert.deepEqual(r.usage, { in: 1200, out: 90 });
  assert.equal(validateMoves(w, c, r.moves).moves.length, 3);
  assert.equal(r.goal, "learn the bakery's habits");
});

test("reflection returns a short diary and a word-limited self note", async () => {
  const w = seedWorld(0);
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
  const model = mockReturning({ diary: ["I fixed a thing.", "Pip talked a lot.", "c", "d", "e-ignored"], self: long });
  const r = await reflectWithModel(w, w.creatures.moss, ["I made a mended thing."], model);
  assert.equal(r.diary.length, 4);
  assert.equal(r.self.split(" ").length, 100);
});
