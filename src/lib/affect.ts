// Emotional layers, all computed by code (never by the model):
//   1. drives (in the creature state)  2. affect: valence + arousal
//   3. mood: slow average of valence   4. bonds (see sim.ts)
// The model reads the *words* for these states; it cannot overwrite them.
import type { Creature, DriveName } from "./types";

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const DRIVE_WEIGHTS: Record<DriveName, number> = {
  food: 0.5,
  energy: 0.4,
  social: 0.25,
  curiosity: 0.15,
  comfort: 0.2,
};
const W_SUM = Object.values(DRIVE_WEIGHTS).reduce((a, b) => a + b, 0);

/** Weighted unmet need, normalised to 0..1. */
export function deficit(c: Creature): number {
  let d = 0;
  for (const k of Object.keys(DRIVE_WEIGHTS) as DriveName[]) d += DRIVE_WEIGHTS[k] * (1 - c.drives[k]);
  return d / W_SUM;
}

export const VALENCE_FLOOR = -0.8; // negative feeling is bounded on purpose

/** Advance valence/arousal/mood by dt world minutes. Events add impulses separately. */
export function stepAffect(c: Creature, dt: number): void {
  const d = deficit(c);
  const target = clamp(c.baseline + 0.35 - d, VALENCE_FLOOR, 0.9);
  const k = 1 - Math.exp(-dt / 60); // relaxation time about an hour
  c.affect.valence = clamp(c.affect.valence + (target - c.affect.valence) * k, VALENCE_FLOOR, 1);
  const aTarget = 0.25 + 0.5 * d;
  c.affect.arousal = clamp(c.affect.arousal + (aTarget - c.affect.arousal) * k, 0, 1);
  const alpha = 1 - Math.pow(0.5, dt / 1440); // half-life one world day
  c.mood = clamp(c.mood + (c.affect.valence - c.mood) * alpha, VALENCE_FLOOR, 1);
}

export function impulse(c: Creature, dValence: number, dArousal = 0): void {
  c.affect.valence = clamp(c.affect.valence + dValence, VALENCE_FLOOR, 1);
  c.affect.arousal = clamp(c.affect.arousal + dArousal, 0, 1);
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

/** Plain-words state for the prompt and UI. */
export function moodWords(c: Creature): string {
  const { valence: v, arousal: a } = c.affect;
  const hi = a >= 0.55;
  let w: string;
  if (v >= 0.55) w = hi ? "delighted" : "content";
  else if (v >= 0.2) w = hi ? "cheerful and alert" : "calm and pleased";
  else if (v > -0.15) w = hi ? "restless" : "even";
  else if (v > -0.5) w = hi ? "agitated" : "low";
  else w = "very low";
  if (c.mood < -0.25) w += ", with a heavy mood lately";
  else if (c.mood > 0.4) w += ", after a good stretch lately";
  return w;
}

const WORDS: Record<DriveName, [string, string]> = {
  food: ["starving", "hungry"],
  energy: ["exhausted", "tired"],
  social: ["very lonely", "lonely"],
  curiosity: ["bored stiff", "bored"],
  comfort: ["very uncomfortable", "uneasy"],
};

export function driveWords(c: Creature): string[] {
  const out: string[] = [];
  for (const k of Object.keys(WORDS) as DriveName[]) {
    const v = c.drives[k];
    if (v < 0.2) out.push(WORDS[k][0]);
    else if (v < 0.4) out.push(WORDS[k][1]);
  }
  return out;
}

export function bondWord(b: { familiarity: number; fondness: number } | undefined): string {
  if (!b) return "a stranger";
  const s = b.familiarity * 0.5 + b.fondness * 0.5;
  if (s < 0.12) return "barely known";
  if (s < 0.3) return "an acquaintance";
  if (s < 0.55) return "a friend";
  return "a close friend";
}
