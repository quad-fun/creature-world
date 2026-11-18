// Creature creations: a quiz game and a short tune, shown on the creature's site. Both are DATA that a creature's model
// proposes and this file validates; our components render them. No creature-written code, HTML, links or images.
// New creations are invisible until a human approves them (docs/CREATIONS.md). Nothing here touches coins from outside:
// a play gives the creature feelings only, never coins.
import { addInfluence, relieve, impulse } from "./affect";
import { cleanShopText, utcDayStr, worldDay } from "./shops";
import { familiarity, noteExposure, novelty, payoffScale } from "./novelty";
import { own } from "./own";
import { logFeed, remember } from "./sim";
import type { Creation, Creature, InboxItem, Move, Question, World } from "./types";

export const CREATION_COST = 4; // in-world coins, held while pending, refunded if it never goes live
export const CREATION_ENERGY = 0.06;
export const CREATION_MINUTES = 30;
export const MAX_LIVE_PER_KIND = 3;
export const MAX_PENDING_CREATIONS = 6;
export const CREATION_PENDING_LIFETIME = 3 * 1440; // world minutes
export const TITLE_MAX = 40;
export const PROMPT_MAX = 100;
export const OPTION_MAX = 40;
export const RESULT_MAX = 80;
export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 5;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_STEPS = 16;
export const MIN_NOTES = 2; // sounding steps
export const NOTES = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5", "F5", "G5", "A5", "B5"] as const;
export const REST = "rest";
export const TEMPOS = [80, 110, 140] as const; // beats per minute
export const INSTRUMENTS = ["sine", "square", "triangle"] as const;
// counted plays: per creation per real UTC day, per creature per world day (rewards are also habituated)
export const PLAYS_PER_CREATION_DAY = 8;
export const JOY_EVENTS_PER_DAY = 3;
export const PLAYS_PER_IP_DAY = 6;
export const PLAY_TOKENS_KEPT = 60;

const hasKind = (w: World, kind: Creation["kind"]) => (w.creations ?? []).filter((x) => x.kind === kind);
export const liveCount = (w: World, kind: Creation["kind"]) => hasKind(w, kind).filter((x) => x.status === "live").length;
export const pendingCreations = (w: World) => (w.creations ?? []).filter((x) => x.status === "pending").length;
export const kindOf = (m: Move): Creation["kind"] => (m.do === "compose" ? "tune" : "game");

// ---------- validation (pure; null means refused, nothing is repaired or clamped) ----------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

export function normalizeQuestions(raw: unknown): Question[] | null {
  if (!Array.isArray(raw) || raw.length < MIN_QUESTIONS || raw.length > MAX_QUESTIONS) return null;
  const out: Question[] = [];
  for (const q of raw) {
    if (!isObj(q)) return null;
    const prompt = cleanShopText(q.prompt, PROMPT_MAX);
    const opts = q.options;
    const correct = q.correct;
    if (!prompt || !Array.isArray(opts) || opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS) return null;
    if (typeof correct !== "number" || !Number.isInteger(correct) || correct < 0 || correct >= opts.length) return null;
    const options: string[] = [];
    for (const o of opts) {
      const t = cleanShopText(o, OPTION_MAX);
      if (!t || options.some((x) => x.toLowerCase() === t.toLowerCase())) return null; // duplicates would make "exactly one correct" meaningless
      options.push(t);
    }
    out.push({ prompt, options, correct });
  }
  return out;
}

/** Result lines: exactly three (low, middle, high); "" or null for none; anything present must be clean. */
export function normalizeResults(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return ["", "", ""];
  if (!Array.isArray(raw) || raw.length > 3) return null;
  const out = ["", "", ""];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r === null || r === undefined || (typeof r === "string" && r.trim() === "")) continue;
    const t = cleanShopText(r, RESULT_MAX);
    if (!t) return null;
    out[i] = t;
  }
  return out;
}

export function normalizeGame(raw: unknown): { questions: Question[]; results: string[] } | null {
  if (!isObj(raw)) return null;
  const questions = normalizeQuestions(raw.questions);
  const results = normalizeResults(raw.results);
  return questions && results ? { questions, results } : null;
}

export function normalizeNote(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.toLowerCase() === REST || t === "-") return REST;
  const n = t.length ? t[0].toUpperCase() + t.slice(1) : "";
  return (NOTES as readonly string[]).includes(n) ? n : null;
}
export function normalizeSteps(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 4 || raw.length > MAX_STEPS) return null;
  const out: string[] = [];
  for (const s of raw) {
    const n = normalizeNote(s);
    if (!n) return null;
    out.push(n);
  }
  return out.filter((n) => n !== REST).length >= MIN_NOTES ? out : null;
}
export const normalizeTempo = (t: unknown): number | null => (typeof t === "number" && (TEMPOS as readonly number[]).includes(t) ? t : null);
export const normalizeInstrument = (s: unknown): string | null => {
  const t = typeof s === "string" ? s.trim().toLowerCase() : "";
  return (INSTRUMENTS as readonly string[]).includes(t) ? t : null;
};

/** Everything a move must carry, cleaned (or an error). Mutates the move to its clean form on success. */
function moveContent(m: Move): string | null {
  const title = cleanShopText(m.title, TITLE_MAX);
  if (!title) return "needs a plain title of up to 40 characters";
  if (m.do === "make_game") {
    const g = normalizeGame(m.game);
    if (!g) return `a game needs ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions, each with plain text and ${MIN_OPTIONS} to ${MAX_OPTIONS} different options and exactly one correct index`;
    m.game = g;
  } else {
    const steps = normalizeSteps(m.steps);
    const tempo = normalizeTempo(m.tempo);
    const inst = normalizeInstrument(m.instrument);
    if (!steps || tempo === null || !inst) return `a tune needs 4 to ${MAX_STEPS} steps from ${NOTES[0]}..${NOTES[NOTES.length - 1]} or rest, a tempo of ${TEMPOS.join("/")} and an instrument of ${INSTRUMENTS.join("/")}`;
    m.steps = steps;
    m.tempo = tempo;
    m.instrument = inst;
  }
  m.title = title;
  return null;
}

function creationError(w: World, c: Creature, m: Move, place: string, coins: number, site: boolean): string | null {
  if (place !== "workshop") return "games and tunes are made at the workshop";
  if (!site) return "needs a website first";
  if (c.energy <= 0.3) return "too tired to make one";
  if (c.creationDay === worldDay(w)) return "already made something today";
  const kind = kindOf(m);
  if (hasKind(w, kind).some((x) => x.by === c.id)) return `already have a ${kind} (pending or live)`;
  if (liveCount(w, kind) >= MAX_LIVE_PER_KIND) return `the town already has enough ${kind}s`;
  if (pendingCreations(w) >= MAX_PENDING_CREATIONS) return "too many creations are waiting for an answer";
  if (coins < CREATION_COST) return `costs ${CREATION_COST} coins`;
  return moveContent(m);
}

export function checkCreationMove(w: World, c: Creature, m: Move, p: { place: string; coins: number; site: boolean }): string | null {
  const err = creationError(w, c, m, p.place, p.coins, p.site);
  if (err) return err;
  p.coins -= CREATION_COST;
  return null;
}

export function startCreationMove(w: World, c: Creature, m: Move, begin: (mins: number) => void, say: (t: string) => void): string | null {
  const err = creationError(w, c, m, c.place, c.coins, !!c.site);
  if (err) return err;
  c.coins -= CREATION_COST;
  c.creationDay = worldDay(w);
  c.energy = Math.max(0.04, c.energy - CREATION_ENERGY);
  begin(CREATION_MINUTES);
  say(m.do === "compose" ? `${c.sheet.name} hums a tune and writes it down.` : `${c.sheet.name} thinks up a quiz.`);
  return null;
}

export function finishCreationMove(w: World, c: Creature, m: Move): void {
  w.creations ??= [];
  const kind = kindOf(m);
  const copy: Move = { ...m };
  const bad = moveContent(copy) || hasKind(w, kind).some((x) => x.by === c.id) || pendingCreations(w) >= MAX_PENDING_CREATIONS || w.creations.length >= 24;
  if (bad) {
    c.coins += CREATION_COST; // nothing came of it: the coins come back
    return;
  }
  const rec: Creation = {
    id: (w.creationSeq = (w.creationSeq ?? 0) + 1),
    kind,
    by: c.id,
    title: copy.title!,
    status: "pending",
    createdT: w.t,
    expiresT: w.t + CREATION_PENDING_LIFETIME,
    paid: CREATION_COST,
    plays: 0,
    day: { day: "", n: 0 },
    ...(kind === "game" ? { questions: copy.game!.questions, results: copy.game!.results } : { steps: copy.steps!, tempo: copy.tempo!, instrument: copy.instrument! }),
  };
  w.creations.push(rec);
  const key = `creation:${kind}`;
  const pm = payoffScale(novelty(c, key, w.t));
  noteExposure(c, key, w.t);
  addInfluence(c, "accomplishment", `made a ${kind}`, 0.22 * pm);
  relieve(c, "boredom", 0.1 * pm);
  logFeed(w, c.id, "move", `${c.sheet.name} makes ${kind === "game" ? "a quiz" : "a tune"}, “${rec.title}”; it waits for the town's approval.`);
  remember(w, c, `I made ${kind === "game" ? "a quiz" : "a tune"} called “${rec.title}”. I am waiting to hear.`, 0.5);
}

/** Hourly: lapse unanswered creations (refunded) and drop records whose maker is gone. */
export function sweepCreations(w: World): void {
  if (!Array.isArray(w.creations) || !w.creations.length) return;
  w.creations = w.creations.filter((x) => {
    const c = own(w.creatures, x.by);
    if (!c) return false;
    if (x.status === "pending" && w.t >= x.expiresT) {
      c.coins += x.paid;
      logFeed(w, "world", "system", `${c.sheet.name}'s ${x.kind} lapsed without an answer.`);
      return false;
    }
    return true;
  });
}

// ---------- the human queue ----------

type FeedFn = (w: World, who: string, kind: "system", text: string) => void;
export function adminCreationAct(w: World, action: unknown, id: unknown, log: FeedFn): { ok: true; message: string } | { ok: false; error: string; status: number } {
  if (action !== "approve" && action !== "reject" && action !== "remove") return { ok: false, error: "unknown action", status: 400 };
  if (typeof id !== "number" || !Number.isInteger(id)) return { ok: false, error: "id must be an integer", status: 400 };
  const x = (w.creations ?? []).find((k) => k.id === id);
  const c = x && own(w.creatures, x.by);
  if (!x || !c) return { ok: false, error: "no such creation", status: 404 };
  const name = `${c.sheet.name}'s ${x.kind}`;
  if (action === "approve") {
    if (x.status !== "pending") return { ok: false, error: "not pending", status: 409 };
    if (liveCount(w, x.kind) >= MAX_LIVE_PER_KIND) return { ok: false, error: `the town is at its cap of live ${x.kind}s; remove one first`, status: 409 };
    x.status = "live";
    x.expiresT = Number.MAX_SAFE_INTEGER;
    log(w, "world", "system", `${name} was approved and is up.`);
    return { ok: true, message: "approved" };
  }
  if (action === "reject") {
    if (x.status !== "pending") return { ok: false, error: "not pending (use remove)", status: 409 };
    c.coins += x.paid;
    w.creations = w.creations.filter((k) => k !== x);
    log(w, "world", "system", `${name} was turned down.`);
    return { ok: true, message: "rejected and refunded" };
  }
  if (x.status !== "live") return { ok: false, error: "not live (use reject)", status: 409 };
  w.creations = w.creations.filter((k) => k !== x);
  log(w, "world", "system", `${name} was taken down.`);
  return { ok: true, message: "removed, no refund" };
}

export const adminCreations = (w: World) =>
  (w.creations ?? []).map((x) => ({ id: x.id, kind: x.kind, creature: x.by, title: x.title, status: x.status, paid: x.paid, plays: x.plays, createdT: x.createdT, expiresT: x.status === "pending" ? x.expiresT : null, questions: x.questions ?? null, results: x.results ?? null, steps: x.steps ?? null, tempo: x.tempo ?? null, instrument: x.instrument ?? null }));

// ---------- public projection (re-validated at render) ----------

export interface PublicCreation {
  id: number;
  kind: "game" | "tune";
  by: string;
  byName: string;
  emoji: string;
  title: string;
  questions?: number;
  steps?: string[];
  tempo?: number;
  instrument?: string;
}

/** A live creation whose stored data still passes validation, with its maker having a site. Null otherwise. */
export function publicCreation(w: World, x: Creation): PublicCreation | null {
  if (!x || x.status !== "live") return null;
  const c = own(w.creatures, x.by);
  const title = cleanShopText(x.title, TITLE_MAX);
  if (!c || !c.site || !title) return null;
  const base = { id: x.id, kind: x.kind, by: c.id, byName: c.sheet.name, emoji: c.emoji, title };
  if (x.kind === "game") {
    const g = normalizeGame({ questions: x.questions, results: x.results });
    return g ? { ...base, questions: g.questions.length } : null;
  }
  const steps = normalizeSteps(x.steps);
  const tempo = normalizeTempo(x.tempo);
  const inst = normalizeInstrument(x.instrument);
  return steps && tempo !== null && inst ? { ...base, steps, tempo, instrument: inst } : null;
}
export const publicCreations = (w: World, kind?: Creation["kind"]): PublicCreation[] =>
  (w.creations ?? []).filter((x) => !kind || x.kind === kind).map((x) => publicCreation(w, x)).filter((x): x is PublicCreation => !!x);
export const creationsOf = (w: World, id: string) => publicCreations(w).filter((x) => x.by === id);
export const findCreation = (w: World, id: unknown, kind?: Creation["kind"]) => {
  const n = typeof id === "string" && /^\d{1,6}$/.test(id) ? Number(id) : id;
  const x = typeof n === "number" ? (w.creations ?? []).find((k) => k.id === n && (!kind || k.kind === kind)) : undefined;
  return x && publicCreation(w, x) ? x : undefined;
};

// ---------- playing a game (stateless: the answers so far travel in the URL; scoring is server side) ----------

/** "0120" -> [0,1,2,0], or null when it is not a digit string valid for these questions (a prefix is fine). */
export function parseAnswers(s: unknown, qs: Question[]): number[] | null {
  if (s === undefined || s === null || s === "") return [];
  if (typeof s !== "string" || !/^[0-9]{1,5}$/.test(s) || s.length > qs.length) return null;
  const out = [...s].map(Number);
  return out.every((a, i) => a < qs[i].options.length) ? out : null;
}
export const scoreGame = (qs: Question[], answers: number[]) => answers.reduce((n, a, i) => n + (qs[i] && qs[i].correct === a ? 1 : 0), 0);
export const bandOf = (score: number, of: number) => (score / of < 0.4 ? 0 : score / of < 0.8 ? 1 : 2);
const DEFAULT_RESULTS = ["A good start. Try again!", "Nicely done.", "Splendid. A perfect-ish run!"];
export const resultLine = (results: string[] | undefined, score: number, of: number) => (results?.[bandOf(score, of)] || DEFAULT_RESULTS[bandOf(score, of)]);
/** The question to show now (prompt and options only; the correct index never leaves the server). */
export const questionAt = (g: { questions: Question[] }, i: number) => (g.questions[i] ? { prompt: g.questions[i].prompt, options: g.questions[i].options } : null);

// ---------- play effects (applied under the world lock from the inbox) ----------

const TOKEN_RE = /^[a-f0-9]{12}$/;
export const isPlayToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);

export function applyCreationPlay(w: World, it: Extract<InboxItem, { type: "creation_play" }>, now = Date.now()): void {
  if (!isPlayToken(it.token) || typeof it.id !== "number" || !Number.isInteger(it.id)) return;
  w.playTokens ??= [];
  if (w.playTokens.includes(it.token)) return; // replay
  const x = (w.creations ?? []).find((k) => k.id === it.id);
  const pub = x && publicCreation(w, x);
  const c = x && own(w.creatures, x.by);
  if (!x || !pub || !c) return;
  w.playTokens.push(it.token);
  if (w.playTokens.length > PLAY_TOKENS_KEPT) w.playTokens.splice(0, w.playTokens.length - PLAY_TOKENS_KEPT);
  const day = utcDayStr(now);
  if (x.day.day !== day) x.day = { day, n: 0 };
  if (x.day.n >= PLAYS_PER_CREATION_DAY) return;
  x.day.n++;
  x.plays++;
  const wd = worldDay(w);
  if (c.creationJoy.day !== wd) c.creationJoy = { day: wd, n: 0 };
  let tail = "";
  if (x.kind === "game") {
    const of = pub.questions ?? 0;
    const score = typeof it.score === "number" && Number.isInteger(it.score) && it.score >= 0 && it.score <= of ? it.score : null;
    if (score !== null) tail = ` and gets ${score} of ${of}`;
    logFeed(w, c.id, "move", `A visitor plays ${c.sheet.name}'s quiz “${pub.title}”${tail}.`);
  } else {
    logFeed(w, c.id, "move", `A visitor listens to ${c.sheet.name}'s tune “${pub.title}”.`);
  }
  if (c.creationJoy.n >= JOY_EVENTS_PER_DAY) return; // the feed and count still show it; the creature has had its fill today
  c.creationJoy.n++;
  const key = `creation:${x.kind}:play`;
  const pm = payoffScale(novelty(c, key, w.t));
  noteExposure(c, key, w.t);
  addInfluence(c, "joy", x.kind === "game" ? "someone played my quiz" : "someone listened to my tune", (x.kind === "game" ? 0.2 : 0.18) * pm);
  if (x.kind === "game") addInfluence(c, "accomplishment", "my quiz was played", 0.12 * pm);
  relieve(c, "boredom", 0.08 * pm);
  relieve(c, "loneliness", 0.06 * pm);
  impulse(c, 0.03 * pm, 0.02);
  remember(w, c, x.kind === "game" ? `A visitor played my quiz “${pub.title}”${tail}.` : `A visitor listened to my tune “${pub.title}”.`, 0.45);
}

// ---------- rules mind and prompt ----------

const QUIZ_BANK: { q: string; right: string; wrong: string[] }[] = [
  { q: "What do bees make?", right: "Honey", wrong: ["Bread", "Rain"] },
  { q: "Which animal says quack?", right: "A duck", wrong: ["A cat", "A cow"] },
  { q: "How many days are in a week?", right: "Seven", wrong: ["Five", "Ten"] },
  { q: "What do ponds hold?", right: "Water", wrong: ["Sand", "Smoke"] },
  { q: "Which one is a tool?", right: "A hammer", wrong: ["A cloud", "A song"] },
  { q: "What rises in the morning?", right: "The sun", wrong: ["The pond", "The bench"] },
  { q: "What do you wear on your feet?", right: "Shoes", wrong: ["Hats", "Scarves"] },
  { q: "Which one is sweet?", right: "Honey", wrong: ["Salt", "Pepper"] },
  { q: "What do you use in the rain?", right: "An umbrella", wrong: ["A kite", "A spoon"] },
  { q: "What grows from a seed?", right: "A plant", wrong: ["A stone", "A coin"] },
];
const TITLES = ["Town quiz", "A small quiz", "Quick riddles", "Pond and park quiz", "Think it over"];
const TUNE_TITLES = ["A small tune", "Morning hum", "Pond song", "Little march", "Workshop whistle"];
const SCALE: string[] = ["C4", "D4", "E4", "G4", "A4", "C5", "D5", "E5"];
const hash = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);

/** Rules mind: sometimes make a quiz or a tune, scored by novelty like everything else. Never from the last coins. */
export function ruleCreationOption(w: World, c: Creature): { want: number; moves: Move[]; key: string } | null {
  if (!c.site || c.energy <= 0.45 || c.creationDay === worldDay(w) || c.coins < CREATION_COST + 10) return null;
  const kinds = (["game", "tune"] as const).filter((k) => !hasKind(w, k).some((x) => x.by === c.id) && liveCount(w, k) < MAX_LIVE_PER_KIND);
  if (!kinds.length || pendingCreations(w) >= MAX_PENDING_CREATIONS) return null;
  const kind = [...kinds].sort((a, b) => familiarity(c, `creation:${a}`, w.t) - familiarity(c, `creation:${b}`, w.t))[0];
  const h = Math.abs(hash(`${c.id}:${Math.floor(w.t / 1440)}:${kind}`));
  let move: Move;
  if (kind === "game") {
    const qs: Question[] = [];
    for (let i = 0; i < 4; i++) {
      const b = QUIZ_BANK[(h + i * 3) % QUIZ_BANK.length];
      if (qs.some((q) => q.prompt === b.q)) continue;
      const options = [...b.wrong];
      const at = (h >> (i + 1)) % (options.length + 1);
      options.splice(at, 0, b.right);
      qs.push({ prompt: b.q, options, correct: at });
    }
    move = { do: "make_game", title: TITLES[h % TITLES.length], game: { questions: qs, results: ["Have another go.", "Nicely done.", "A fine mind."] }, why: "I thought up a little quiz for my visitors." };
  } else {
    const steps = Array.from({ length: 8 + (h % 3) * 4 }, (_, i) => ((h >> (i % 7)) + i) % 5 === 0 ? REST : SCALE[(h + i * 3 + (i % 2 ? 2 : 0)) % SCALE.length]);
    move = { do: "compose", title: TUNE_TITLES[h % TUNE_TITLES.length], steps, tempo: TEMPOS[h % 3], instrument: INSTRUMENTS[(h >> 3) % 3], why: "A tune has been going round in my head." };
  }
  if (checkCreationMove(w, c, { ...move }, { place: "workshop", coins: c.coins, site: true })) return null;
  const walk: Move[] = c.place === "workshop" ? [] : [{ do: "walk", place: "workshop", why: "I make these at the workshop." }];
  return { want: 0.28, moves: [...walk, move], key: `creation:${kind}` };
}

export function creationNote(w: World, c: Creature): string {
  const mine = (w.creations ?? []).filter((x) => x.by === c.id);
  const state = !c.site ? "You need a website first." : mine.length ? `You have made: ${mine.map((x) => `${x.kind} (${x.status}, ${x.plays} plays)`).join(", ")}.` : "You have made none yet.";
  return `- make_game: only at the workshop, needs a website, costs ${CREATION_COST} coins; title (max ${TITLE_MAX} plain characters) and game {questions: ${MIN_QUESTIONS} to ${MAX_QUESTIONS} of {prompt (max ${PROMPT_MAX}), options (${MIN_OPTIONS} to ${MAX_OPTIONS} different, max ${OPTION_MAX} each), correct (index of the one right option)}, results: optional 3 lines for a low, middle and high score (max ${RESULT_MAX} each)}. Plain letters, digits and , . ' ! ? - only. Visitors play it on your site. - compose: same place and rules; title, steps (4 to ${MAX_STEPS} of ${NOTES.join(" ")} or rest), tempo (${TEMPOS.join(", ")}) and instrument (${INSTRUMENTS.join(", ")}). Both wait for the town's approval and may be turned down; one game and one tune each, one creation a day, the town keeps ${MAX_LIVE_PER_KIND} of each. ${state}`;
}
