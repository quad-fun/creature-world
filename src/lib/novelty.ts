// Novelty and interests. Pure functions over creature state; no world access.
//   familiarity: recent exposure counts per activity / place / item / person, decaying with time
//   novelty:     1 for something fresh, falling toward 0 as it is repeated
//   interests:   a few topics whose strength grows with exposure (bounded)
import type { Creature, Interest, ItemId, MoveKind, PlaceId } from "./types";

export const FAMILIARITY_HALF_LIFE = 480; // world minutes
export const MAX_INTERESTS = 4;
const INTEREST_HALF_LIFE = 5 * 1440;
const FAM_CAP = 12;

export function familiarity(c: Creature, key: string, t: number): number {
  const e = c.familiarity[key];
  if (!e) return 0;
  return e.n * Math.pow(0.5, Math.max(0, t - e.t) / FAMILIARITY_HALF_LIFE);
}

/** Record one exposure. Returns nothing; call novelty() BEFORE this to price the thing being done now. */
export function noteExposure(c: Creature, key: string, t: number): void {
  c.familiarity[key] = { n: Math.min(FAM_CAP, familiarity(c, key, t) + 1), t };
  const keys = Object.keys(c.familiarity);
  if (keys.length > 60) {
    for (const k of keys) if (familiarity(c, k, t) < 0.05) delete c.familiarity[k];
  }
}

/** 1 = brand new, about 0.45 after 2 recent repeats, 0.2 after 7. */
export function novelty(c: Creature, key: string, t: number): number {
  return 1 / (1 + 0.6 * familiarity(c, key, t));
}

/** How much of the usual payoff a repeat still earns: 0.25..1. */
export const payoffScale = (nov: number): number => 0.25 + 0.75 * nov;

/** Keys with high recent familiarity, for the prompt ("feels stale"). */
export function staleKeys(c: Creature, t: number, min = 2.2): string[] {
  return Object.keys(c.familiarity)
    .map((k) => [k, familiarity(c, k, t)] as const)
    .filter(([, f]) => f >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

// ---------- interests ----------

export const TOPICS = ["mending", "shiny things", "herbs", "gossip", "mud and water", "wandering"] as const;

const ITEM_TOPIC: Partial<Record<ItemId, string>> = { "mended-thing": "mending", trinket: "shiny things", potion: "herbs" };
const PLACE_TOPIC: Partial<Record<PlaceId, string>> = { pond: "mud and water", park: "wandering", fountain: "gossip" };

/** Which topic an activity feeds, if any. */
export function topicOf(kind: MoveKind, place: PlaceId, item?: ItemId): string | undefined {
  if (kind === "craft" && item) return ITEM_TOPIC[item];
  if (kind === "speak") return "gossip";
  if (kind === "play") return PLACE_TOPIC[place] ?? "wandering";
  return undefined;
}

/** The kind of move that makes progress on a pursuit about this topic. */
export function stepKindFor(topic: string): MoveKind {
  if (topic === "gossip") return "speak";
  if (topic === "wandering" || topic === "mud and water") return "play";
  return "craft";
}

const KEYWORDS: Record<string, string[]> = {
  mending: ["mend", "fix", "repair", "useful"],
  "shiny things": ["shiny", "collect", "trinket", "bargain"],
  herbs: ["herb", "potion", "plant", "garden"],
  gossip: ["gossip", "chat", "talk", "news"],
  "mud and water": ["mud", "pond", "water", "rain"],
  wandering: ["wander", "walk", "explor", "question"],
};

/** Starting interests from the sheet, so a new creature is not a blank. */
export function seedInterests(c: Creature): Interest[] {
  const text = [...c.sheet.likes, ...c.sheet.temperament].join(" ").toLowerCase();
  const out: Interest[] = [];
  for (const topic of TOPICS) {
    if (KEYWORDS[topic].some((k) => text.includes(k))) out.push({ topic, strength: 0.2, t: 0 });
  }
  return out.slice(0, 2);
}

export function interestStrength(c: Creature, topic: string): number {
  return c.interests.find((i) => i.topic === topic)?.strength ?? 0;
}

/** Strength grows with exposure and fades slowly without it. Bounded to MAX_INTERESTS topics. */
export function exposeInterest(c: Creature, topic: string, t: number, amount = 0.05): void {
  for (const i of c.interests) {
    i.strength *= Math.pow(0.5, Math.max(0, t - i.t) / INTEREST_HALF_LIFE);
    i.t = t;
  }
  c.interests = c.interests.filter((i) => i.strength >= 0.04 || i.topic === topic);
  let it = c.interests.find((i) => i.topic === topic);
  if (!it) {
    if (c.interests.length >= MAX_INTERESTS) {
      const weakest = [...c.interests].sort((a, b) => a.strength - b.strength)[0];
      if (weakest.strength > 0.15) return; // all four are established; a passing fancy does not displace them
      c.interests.splice(c.interests.indexOf(weakest), 1);
    }
    it = { topic, strength: 0, t };
    c.interests.push(it);
  }
  it.strength = Math.min(1, it.strength + amount * (1 - 0.5 * it.strength));
}

export function interestWord(s: number): string {
  return s >= 0.65 ? "strong" : s >= 0.35 ? "growing" : "faint";
}

const PURSUIT_TITLES: Record<string, string[]> = {
  mending: ["restore the old workshop clock", "fix up something the town gave up on"],
  "shiny things": ["assemble a display of the brightest things", "make one truly dazzling piece"],
  herbs: ["brew a proper remedy for the town", "perfect a calming herbal blend"],
  gossip: ["learn everyone's story", "start a rumour that turns out true"],
  "mud and water": ["map every puddle by the pond", "find where the pond goes at night"],
  wandering: ["walk every corner of the town", "find a new favourite spot"],
};
export const pursuitTitle = (topic: string, n: number) => (PURSUIT_TITLES[topic] ?? ["a little project"])[n % (PURSUIT_TITLES[topic]?.length ?? 1)];

export function pursuitWord(p: { progress: number; steps: number }): string {
  const f = p.progress / p.steps;
  return f >= 0.67 ? "nearly done" : f >= 0.34 ? "partway there" : "just begun";
}
