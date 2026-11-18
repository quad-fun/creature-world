// The tick engine. On Vercel there is no long-running process, so the world advances lazily:
// every call works out how much world time has passed, steps the world through it cheaply
// (rules only for the catch-up), and consults the model only for the present moment.
import { decideWithModel, modelAvailable, reflectWithModel } from "./mind";
import { ruleMoves } from "./rules";
import { seedWorld } from "./content";
import { isLibraryMove, prepareMakes } from "./library";
import { applyInbox } from "./inbox";
import { refreshOutside } from "./outside";
import { appraiseGifts } from "./appraise";
import { cleanLine } from "./library";
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
  modelWindowMs: MODEL_WINDOW_MS,
});

/**
 * No NEW model call starts after this long into a locked tick. Every call is bounded by a 20s abort signal, so a tick
 * ends well inside the 55s lock TTL and the 60s function limit (25s + 20s + a little storage time).
 */
export const MODEL_WINDOW_MS = 25_000;

/** A catch-up of at least this many steps (one world hour) earns each creature at most one model decision. */
export const CATCHUP_MIN_STEPS = 12;

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

function noteModelError(st: World["stats"], e: unknown) {
  st.errors++;
  st.consecutiveErrors++;
  st.lastError = String((e as Error)?.message ?? e).slice(0, 200);
  if (st.consecutiveErrors >= 4) st.pausedUntilMs = Date.now() + 10 * 60_000; // circuit breaker
}
function noteModelOk(st: World["stats"], u: { in: number; out: number }) {
  st.modelCalls++;
  st.consecutiveErrors = 0;
  st.inputTokens += u.in;
  st.outputTokens += u.out;
}

/**
 * Catch-up flavour: AT MOST ONE model decision per creature per tick, however many steps are caught up (never inside the
 * step loop, never repeated). It sets a fresh goal that the rules mind then follows for the rest of the absence, and,
 * if the creature is idle, its first move. Same gates as every other call: the daily cap (it counts against it), the
 * circuit breaker, and the model window (a call may only START in the first half of the window, so the present-moment
 * calls that follow still fit). Library moves (make, launch_site) are dropped: they need a second, writing call.
 */
async function catchUpThink(w: World, c: Creature, startMs: number) {
  const day = utcDay();
  if (c.calls.day !== day) c.calls = { day, n: 0 };
  const st = w.stats;
  if (c.calls.n >= config().dailyCalls || (st.pausedUntilMs ?? 0) >= Date.now() || Date.now() >= startMs + config().modelWindowMs / 2) return;
  try {
    c.calls.n++;
    const r = await decideWithModel(w, c);
    noteModelOk(st, r.usage);
    if (r.goal) c.goal = r.goal;
    if (!c.activity && c.queue.length === 0) {
      const v = validateMoves(w, c, r.moves.filter((m) => !isLibraryMove(String((m as { do?: unknown })?.do) as never)));
      if (v.moves.length) {
        c.lastSource = "model";
        c.queue = v.moves;
        c.lastDecisionT = w.t;
        kickQueue(w, c);
      }
    }
  } catch (e) {
    noteModelError(st, e);
  }
}

async function think(w: World, c: Creature, canUseModel: boolean, deadline = Infinity) {
  const day = utcDay();
  if (c.calls.day !== day) c.calls = { day, n: 0 };
  const st = w.stats;
  const budgetOk = () => c.calls.n < config().dailyCalls;
  const modelOk = () => canUseModel && budgetOk() && (st.pausedUntilMs ?? 0) < Date.now() && Date.now() < deadline;

  const noteError = (e: unknown) => noteModelError(st, e);
  const noteOk = (u: { in: number; out: number }) => noteModelOk(st, u);

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
        // The diary and the self-note are public and feed the next prompt: same filter as visitor text, line by line.
        const lines = r.diary.map((l) => cleanLine(l, 300)).filter((l): l is string => !!l);
        for (const line of lines) c.diary.push({ t: w.t, text: line });
        const self = cleanLine(r.self, 700);
        if (self) c.sheet.self = self; // locked lines are never touched
        if (lines.length) {
          logFeed(w, c.id, "diary", `${c.sheet.name} writes in the diary.`, lines.join(" "), "model");
          done = true;
        }
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
        await prepareMakes(w, c, v.moves, { modelOk, spend: () => c.calls.n++, noteOk, noteError }); // at most one more bounded call
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
    const tickStart = Date.now();
    world = (await store.load()) ?? world; // reload after taking the lock
    const inbox = (await store.drainInbox()).filter((it) => it && typeof it === "object" && typeof (it as { type?: unknown }).type === "string");
    if (inbox.length) {
      try {
        await appraiseGifts(world, inbox, { deadline: Date.now() + cfg.modelWindowMs }); // few cheap calls a day, at most 2 per tick; rules fallback otherwise
      } catch (e) {
        console.error("appraisal failed", (e as Error)?.message); // never lose the rest of the batch or the tick
      }
      for (const r of applyInbox(world, inbox)) {
        try {
          await store.kv.incrby(r.key, -r.coins); // a failed purchase gives the visitor's reserved coins back
        } catch (e) {
          console.error("visitor coin refund failed", (e as Error)?.message);
        }
      }
    }
    await refreshOutside(world, store.kv); // weather and date: seeded, or one cached, timed-out, silent-on-failure live read
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

    // One bounded model decision per creature before a long catch-up (parallel, so it costs one call's time at most).
    if (steps >= CATCHUP_MIN_STEPS && modelAvailable()) {
      await Promise.all(Object.values(world.creatures).map((c) => catchUpThink(world, c, tickStart)));
    }

    let need: string[] = [];
    for (let i = 0; i < steps; i++) {
      need = stepWorld(world);
      if (i < steps - 1) for (const id of need) applyRules(world, world.creatures[id]); // catch-up: rules only
    }

    // Present moment: the model gets a say for creatures who need to decide or reflect.
    const useModel = modelAvailable();
    const deadline = tickStart + cfg.modelWindowMs; // no new call starts later than this, counted from the start of the locked tick
    const waking = Object.values(world.creatures).filter((c) => c.sleptSinceReflect && !c.activity).map((c) => c.id);
    const ids = [...new Set([...need, ...waking])];
    await Promise.all(ids.map((id) => think(world, world.creatures[id], useModel, deadline)));
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
