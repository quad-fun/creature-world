import { ruleMoves } from "../src/lib/rules";
import { kickQueue } from "../src/lib/sim";
import type { Creature, World } from "../src/lib/types";

/** Same as the engine's rule fallback, exposed for tests and the offline simulation. */
export function applyRulesForTest(w: World, c: Creature) {
  c.lastDecisionT = w.t;
  c.lastSource = "rules";
  c.queue = ruleMoves(w, c);
  kickQueue(w, c);
}
