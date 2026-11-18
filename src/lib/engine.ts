// The tick engine. On Vercel there is no long-running process, so the world advances lazily:
// every call works out how much world time has passed, steps the world through it cheaply
// (rules only for the catch-up), and consults the model only for the present moment.
import { decideWithModel, modelAvailable, reflectWithModel } from "./mind";
import { ruleMoves } from "./rules";
import { seedWorld } from "./content";
import { applyInbox } from "./inbox";
import { STEP, kickQueue, logFeed, needsDecision, stepWorld, validateMoves } from "./sim";
import { getStore } from "./store";
import type { Creature, World } from "./types";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : d;
};
export const config = () => ({
  timeScale: num(process.env.TIME_SCALE, 20),
  minTickS: num(process.env.MIN_TICK_INTERVAL_S, 20),
  dailyCalls: num(process.env.DAILY_CALLS_PER_CREATURE, 200),
  maxSteps: 288, // at most one world day of catch-up per call
});

const utcDay = () => new Date().toISOString().slice(0, 10);

function applyRules(w: World, c: Creature) {
  c.lastDecisionT = w.t;
  c.lastSource = "rules";
  c.queue = ruleMoves(w, c);
  kickQueue(w, c);
}

/** Rule-based reflection: a diary line from the most salient recent memories. */
function ruleReflect(w: World, c: Creature) {
  const recent = [...c.memories].filter((m) => m.t > (c.diary.at(-1)?.t ?? -1)).sort((a, b) => b.salience - a.salience).slice(0, 3);
  for (const m of recent.reverse()) c.diary.push({ t: w.t, text: m.text });
}

function consolidate(w: World, c: Creature) {
  // forget what is old and unremarkable; emotionally weighty memories stay
  c.memories = c.memories.filter((m) => w.t - m.t < 1440 || m.salience >= 0.4);
  if (c.memories.length > 50) c.memories = [...c.memories].sort((a, b) => b.salience - a.salience).slice(0, 50).sort((a, b) => a.t - b.t);
  if (c.diary.length > 60) c.diary = c.diary.slice(-60);
}

async function think(w: World, c: Creature, canUseModel: boolean) {
  const day = utcDay();
  if (c.calls.day !== day) c.calls = { day, n: 0 };
  const st = w.stats;
  const budgetOk = () => c.calls.n < config().dailyCalls;
  const modelOk = () => canUseModel && budgetOk() && (st.pausedUntilMs ?? 0) < Date.now();

  const noteError = (e: unknown) => {
    st.errors++;
    st.consecutiveErrors++;
    st.lastError = String((e as Error)?.message ?? e).slice(0, 200);
    if (st.consecutiveErrors >= 4) st.pausedUntilMs = Date.now() + 10 * 60_000; // circuit breaker
  };
  const noteOk = (u: { in: number; out: number }) => {
    st.modelCalls++;
    st.consecutiveErrors = 0;
    st.inputTokens += u.in;
    st.outputTokens += u.out;
  };

  // Waking up: write the diary and let the creature revise its own note about itself.
  if (c.sleptSinceReflect && !c.activity) {
    c.sleptSinceReflect = false;
    const recent = [...c.memories].filter((m) => m.t > (c.diary.at(-1)?.t ?? -1)).sort((a, b) => b.salience - a.salience).slice(0, 10).map((m) => m.text);
    let done = false;
    if (modelOk() && recent.length) {
      try {
        c.calls.n++;
        const r = await reflectWithModel(w, c, recent);
        noteOk(r.usage);
        for (const line of r.diary) if (line.trim()) c.diary.push({ t: w.t, text: line });
        if (r.self.trim()) c.sheet.self = r.self; // locked lines are never touched
        logFeed(w, c.id, "diary", `${c.sheet.name} writes in the diary.`, r.diary.join(" "), "model");
        done = true;
      } catch (e) {
        noteError(e);
      }
    }
    if (!done) ruleReflect(w, c);
    consolidate(w, c);
  }

  if (!needsDecision(w, c)) return;
  c.lastDecisionT = w.t;

  if (modelOk()) {
    try {
      c.calls.n++;
      const r = await decideWithModel(w, c);
      noteOk(r.usage);
      if (r.goal) c.goal = r.goal;
      const v = validateMoves(w, c, r.moves);
      if (v.moves.length) {
        c.lastSource = "model";
        c.queue = v.moves;
        kickQueue(w, c);
        return;
      }
      st.errors++;
      st.lastError = `no valid moves: ${v.rejected.join("; ") || "empty"}`;
    } catch (e) {
      noteError(e);
    }
  }
  st.fallbacks++;
  applyRules(w, c);
}

export interface TickResult {
  ran: boolean;
  steps: number;
  world: World;
}

export async function advanceWorld(opts: { force?: boolean } = {}): Promise<TickResult> {
  const store = getStore();
  const cfg = config();
  let world: World = (await store.load()) ?? seedWorld(Date.now());
  if (!(await store.load())) await store.save(world);
  if (!opts.force && Date.now() - world.lastRealMs < cfg.minTickS * 1000) return { ran: false, steps: 0, world };
  if (!(await store.lock(55))) return { ran: false, steps: 0, world };
  try {
    world = (await store.load()) ?? world; // reload after taking the lock
    const inbox = await store.drainInbox();
    if (inbox.length) applyInbox(world, inbox);
    const now = Date.now();
    let steps = Math.floor((((now - world.lastRealMs) / 60_000) * cfg.timeScale) / STEP);
    if (steps < 1) {
      if (!opts.force) {
        if (inbox.length) await store.save(world); // never drop what visitors left
        return { ran: false, steps: 0, world };
      }
      steps = 1;
      world.lastRealMs = now;
    } else if (steps > cfg.maxSteps) {
      steps = cfg.maxSteps; // long absence: skip ahead, the town simply carried on
      world.lastRealMs = now;
    } else {
      world.lastRealMs += ((steps * STEP) / cfg.timeScale) * 60_000;
    }
    if (steps >= 24) logFeed(world, "world", "system", `Time passes in the town (${Math.round((steps * STEP) / 60)} hours).`);

    let need: string[] = [];
    for (let i = 0; i < steps; i++) {
      need = stepWorld(world);
      if (i < steps - 1) for (const id of need) applyRules(world, world.creatures[id]); // catch-up: rules only
    }

    // Present moment: the model gets a say for creatures who need to decide or reflect.
    const useModel = modelAvailable();
    const waking = Object.values(world.creatures).filter((c) => c.sleptSinceReflect && !c.activity).map((c) => c.id);
    const ids = [...new Set([...need, ...waking])];
    await Promise.all(ids.map((id) => think(world, world.creatures[id], useModel)));
    await store.save(world);
    return { ran: true, steps, world };
  } finally {
    await store.unlock();
  }
}

export async function loadWorld(): Promise<{ world: World; storage: "redis" | "memory" }> {
  const store = getStore();
  let world = await store.load();
  if (!world) {
    world = seedWorld(Date.now());
    await store.save(world);
  }
  return { world, storage: store.kind };
}
