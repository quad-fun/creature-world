// Emotional model, all computed by code (never by the model):
//   Core state: mood and energy (0..1), the only two bars.
//   Everything else (hunger, loneliness, boredom, comfort, accomplishment, joy, fear) is a named,
//   temporary Influence that pushes those two bars. Pushes sum, the sum is capped, and mood has a
//   floor, so a creature cannot spiral to zero. Sleep and rest restore energy (see sim.ts).
// The model reads WORDS for these states; it cannot overwrite them.
import type { Creature, Influence, InfluenceKind, NeedKind } from "./types";

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const MOOD_FLOOR = 0.1;
export const MOOD_CEIL = 0.95;
export const ENERGY_FLOOR = 0.04;
export const PUSH_CAP = { moodDown: -0.45, moodUp: 0.4, energy: 0.6 };
export const NEED_KINDS: NeedKind[] = ["hunger", "loneliness", "boredom", "comfort"];

interface Def {
  label: string;
  mood: number;
  energy: number;
  need: boolean;
  halfLife?: number;
  words: [string, string, string]; // faint, clear, strong
}

export const DEFS: Record<InfluenceKind, Def> = {
  hunger: { label: "hunger", mood: -0.45, energy: -0.4, need: true, words: ["a little hungry", "hungry", "starving"] },
  loneliness: { label: "loneliness", mood: -0.4, energy: -0.1, need: true, words: ["a little lonely", "lonely", "very lonely"] },
  boredom: { label: "boredom", mood: -0.3, energy: -0.25, need: true, words: ["a little bored", "bored", "bored stiff"] },
  comfort: { label: "discomfort", mood: -0.25, energy: -0.15, need: true, words: ["a little uneasy", "uneasy", "very uncomfortable"] },
  accomplishment: { label: "accomplishment", mood: 0.4, energy: 0.1, need: false, halfLife: 360, words: ["quietly pleased with something done", "proud of something done", "very proud of something done"] },
  joy: { label: "joy", mood: 0.45, energy: 0.2, need: false, halfLife: 150, words: ["a little happy", "happy", "delighted"] },
  fear: { label: "fear", mood: -0.4, energy: 0.2, need: false, halfLife: 90, words: ["a little nervous", "frightened", "terrified"] },
};

export function makeInfluence(kind: InfluenceKind, source: string, level: number): Influence {
  const d = DEFS[kind];
  return { kind, label: d.label, source, level: clamp(level, 0, 1), mood: d.mood, energy: d.energy, need: d.need, halfLife: d.halfLife };
}

/** Need influences always exist on a creature; call when creating or migrating. */
export function ensureNeeds(c: Creature, start: Partial<Record<NeedKind, number>> = {}): void {
  const src: Record<NeedKind, string> = { hunger: "it has been a while since eating", loneliness: "little company lately", boredom: "nothing new lately", comfort: "wear and weather" };
  const init: Record<NeedKind, number> = { hunger: 0.2, loneliness: 0.3, boredom: 0.3, comfort: 0.2 };
  c.influences ??= [];
  for (const k of NEED_KINDS) {
    if (!c.influences.some((i) => i.kind === k && i.need)) c.influences.push(makeInfluence(k, src[k], start[k] ?? init[k]));
  }
}

export function needLevel(c: Creature, kind: NeedKind): number {
  return c.influences.find((i) => i.kind === kind && i.need)?.level ?? 0;
}
/** Move a need's level by delta (positive = worse). */
export function bumpNeed(c: Creature, kind: NeedKind, delta: number): void {
  const i = c.influences.find((x) => x.kind === kind && x.need);
  if (i) i.level = clamp(i.level + delta, 0, 1);
}
export const relieve = (c: Creature, kind: NeedKind, amount: number) => bumpNeed(c, kind, -amount);

export const MAX_EVENT_INFLUENCES = 8;

/** Add or refresh a temporary influence. Same kind+source refreshes to the higher level. */
export function addInfluence(c: Creature, kind: InfluenceKind, source: string, level: number): void {
  if (DEFS[kind].need) return bumpNeed(c, kind as NeedKind, level);
  if (level < 0.05) return;
  const found = c.influences.find((i) => !i.need && i.kind === kind && i.source === source);
  if (found) {
    found.level = clamp(Math.max(found.level, level), 0, 1);
    return;
  }
  c.influences.push(makeInfluence(kind, source, level));
  const events = c.influences.filter((i) => !i.need);
  if (events.length > MAX_EVENT_INFLUENCES) {
    const weakest = events.sort((a, b) => a.level - b.level)[0];
    c.influences.splice(c.influences.indexOf(weakest), 1);
  }
}

export const ACTIVE_LEVEL = 0.12;

/** Sum of active influences' pushes, capped. This is the only way influences touch the bars. */
export function totals(c: Creature): { mood: number; energy: number } {
  let m = 0;
  let e = 0;
  for (const i of c.influences) {
    if (i.level < ACTIVE_LEVEL) continue;
    m += i.mood * i.level;
    e += i.energy * i.level;
  }
  return { mood: clamp(m, PUSH_CAP.moodDown, PUSH_CAP.moodUp), energy: clamp(e, -PUSH_CAP.energy, PUSH_CAP.energy) };
}

/** Advance mood by dt world minutes and fade temporary influences. Energy is advanced in sim.ts. */
export function stepAffect(c: Creature, dt: number): void {
  const tot = totals(c);
  const tired = c.energy < 0.3 ? -(0.3 - c.energy) * 0.6 : 0;
  const target = clamp(c.baseline + clamp(tot.mood + tired, PUSH_CAP.moodDown, PUSH_CAP.moodUp), MOOD_FLOOR, MOOD_CEIL);
  const k = 1 - Math.exp(-dt / 60); // relaxation time about an hour
  c.mood = clamp(c.mood + (target - c.mood) * k, MOOD_FLOOR, 1);
  for (const i of c.influences) if (!i.need && i.halfLife) i.level *= Math.pow(0.5, dt / i.halfLife);
  c.influences = c.influences.filter((i) => i.need || i.level >= 0.05);
}

/** One-off nudge to the bars (an event). Mood never drops below the floor. */
export function impulse(c: Creature, dMood: number, dEnergy = 0): void {
  c.mood = clamp(c.mood + dMood, MOOD_FLOOR, 1);
  c.energy = clamp(c.energy + dEnergy, ENERGY_FLOOR, 1);
}

export function matches(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.includes(y) || y.includes(x);
}

/** How well something fits the creature's sheet: -0.6..0.6 */
export function appraise(c: Creature, tags: string[], text = ""): number {
  let s = 0;
  const lower = text.toLowerCase();
  for (const like of c.sheet.likes) {
    if (tags.some((t) => matches(t, like)) || (lower && lower.includes(like.toLowerCase()))) s += 0.3;
  }
  for (const dis of c.sheet.dislikes) {
    if (tags.some((t) => matches(t, dis)) || (lower && lower.includes(dis.toLowerCase()))) s -= 0.3;
  }
  return clamp(s, -0.6, 0.6);
}

// ---------- words for the prompt and UI ----------

export function moodWord(mood: number): string {
  if (mood < 0.2) return "very low";
  if (mood < 0.38) return "low";
  if (mood < 0.52) return "flat";
  if (mood < 0.7) return "good";
  return "bright";
}
export function energyWord(e: number): string {
  if (e < 0.2) return "exhausted";
  if (e < 0.4) return "tired";
  if (e < 0.7) return "steady";
  return "full of energy";
}
/** e.g. "low mood, tired" */
export function moodWords(c: Creature): string {
  return `${moodWord(c.mood)} mood, ${energyWord(c.energy)}`;
}

export function influenceWord(i: Influence): string {
  const w = DEFS[i.kind].words;
  return i.level >= 0.75 ? w[2] : i.level >= 0.45 ? w[1] : w[0];
}

/** Active influences, strongest first. Needs show only when they are noticeable. */
export function activeInfluences(c: Creature): Influence[] {
  return c.influences.filter((i) => i.level >= (i.need ? 0.3 : 0.15)).sort((a, b) => b.level * Math.abs(b.mood) - a.level * Math.abs(a.mood));
}
export const influenceWords = (c: Creature): string[] => activeInfluences(c).map(influenceWord);
/** Words only: "a little lonely (little company lately)". */
export const influenceLines = (c: Creature): string[] => activeInfluences(c).map((i) => `${influenceWord(i)} (${i.source})`);

export function bondWord(b: { familiarity: number; fondness: number } | undefined): string {
  if (!b) return "a stranger";
  const s = b.familiarity * 0.5 + b.fondness * 0.5;
  if (s < 0.12) return "barely known";
  if (s < 0.3) return "an acquaintance";
  if (s < 0.55) return "a friend";
  return "a close friend";
}
