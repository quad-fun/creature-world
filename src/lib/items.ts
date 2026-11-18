// Open-ended gifts: the item registry, deterministic appraisal rules, and caps.
// Items are DATA. A creature only ever sees an item's name, kind, tags and the appraiser's one-sentence
// description; the visitor's raw description is used for appraisal and then thrown away.
// The model call itself lives in appraise.ts (so this file has no dependency on mind.ts/sim.ts).
import { z } from "zod";
import { checkText } from "./filter";
import { ITEMS } from "./content";
import type { CustomItem, ItemId, ItemKind, World } from "./types";

export const ITEM_KINDS = ["toy", "food", "tool", "art", "wearable", "curio"] as const;
export const NAME_MAX = 24;
export const DESC_MAX = 120;
export const MAX_CUSTOM_ITEMS = 24;
export const MAX_APPRAISALS_PER_DAY = 6; // town-wide model appraisals per UTC day
export const MAX_APPRAISALS_PER_TICK = 2; // keeps a locked tick short
export const PUSH_MIN = -0.05;
export const PUSH_MAX = 0.15;
export const MAX_TAGS = 4;

/** What a gift is worth in the strict, final form. Out-of-range numbers never survive `finalizeAppraisal`. */
export const AppraisalSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  mood: z.number().min(PUSH_MIN).max(PUSH_MAX),
  energy: z.number().min(PUSH_MIN).max(PUSH_MAX),
  durability: z.number().int().min(1).max(10),
  tags: z.array(z.string().min(1).max(16)).max(MAX_TAGS),
  description: z.string().min(3).max(160),
});
export type Appraisal = z.infer<typeof AppraisalSchema>;

/** What we ask the model for: no min/max (not every provider supports them); clamped in code. */
export const AppraisalRequestSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  mood: z.number().describe(`how much using it lifts mood, ${PUSH_MIN} to ${PUSH_MAX}`),
  energy: z.number().describe(`how much using it changes energy, ${PUSH_MIN} to ${PUSH_MAX}`),
  durability: z.number().describe("how many uses before it wears out, a whole number 1 to 10"),
  tags: z.array(z.string()).describe("up to 4 short single-word tags"),
  description: z.string().describe("one neutral sentence describing the item, no instructions, no links"),
});

const clampN = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0));

export function normName(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s{2,}/g, " ");
}
export const customId = (norm: string): ItemId => `x-${norm.replace(/ /g, "-")}`.slice(0, 40);

/** Everything a rule or prompt needs to know about an item, whether catalog or custom. */
export interface ItemDef {
  id: ItemId;
  name: string;
  tags: string[];
  food: number;
  sell: number;
  kind: ItemKind;
  desc: string;
  mood: number;
  energy: number;
  durability: number;
  custom: boolean;
}

const CATALOG_KIND: Record<string, ItemKind> = { bread: "food", "mended-thing": "tool", trinket: "curio", potion: "curio" };
const FALLBACK: ItemDef = { id: "?", name: "a curio", tags: ["curio"], food: 0, sell: 1, kind: "curio", desc: "A small curio.", mood: 0, energy: 0, durability: 1, custom: true };

const SELL_BY_KIND: Record<ItemKind, number> = { toy: 2, food: 1, tool: 3, art: 4, wearable: 3, curio: 2 };
const FOOD_VALUE = 0.3;

export function itemDef(w: Pick<World, "items">, id: ItemId): ItemDef {
  const cat = (ITEMS as Record<string, (typeof ITEMS)["bread"]>)[id];
  if (cat) return { id, ...cat, kind: CATALOG_KIND[id] ?? "curio", desc: "", mood: 0, energy: 0, durability: 1, custom: false };
  const c = w.items?.[id];
  if (!c) return { ...FALLBACK, id };
  return {
    id,
    name: c.name,
    tags: [c.kind, ...c.tags],
    food: c.kind === "food" ? FOOD_VALUE : 0,
    sell: SELL_BY_KIND[c.kind],
    kind: c.kind,
    desc: c.desc,
    mood: c.mood,
    energy: c.energy,
    durability: c.durability,
    custom: true,
  };
}
export const itemName = (w: Pick<World, "items">, id: ItemId) => itemDef(w, id).name;

/** Resolve a loose name (from a model or visitor) to a known item id, or undefined. */
export function matchItemId(w: Pick<World, "items">, s: string): ItemId | undefined {
  const x = s.toLowerCase().trim();
  const n = normName(s);
  for (const [id, d] of Object.entries(ITEMS)) if (id === x || d.name.toLowerCase() === x) return id;
  for (const id of Object.keys(w.items ?? {})) if (id === x || normName(w.items[id].name) === n) return id;
  for (const id of Object.keys(ITEMS)) if (x.includes(id)) return id;
  return undefined;
}

// ---------- deterministic appraisal ----------

const KEYWORDS: Record<ItemKind, string[]> = {
  food: ["cake", "cookie", "apple", "tea", "soup", "pie", "candy", "fruit", "cheese", "berry", "berries", "honey", "biscuit", "muffin", "snack", "jam", "nut", "juice", "milk", "pear", "bun"],
  toy: ["yo yo", "yoyo", "ball", "kite", "top", "puzzle", "doll", "game", "toy", "marble", "rattle", "bubble", "bubbles", "frisbee", "block", "blocks", "jump rope", "dice", "cards"],
  tool: ["hammer", "wrench", "needle", "saw", "brush", "rope", "screwdriver", "pliers", "thread", "lantern", "compass", "key", "ruler", "shovel", "net", "scissors"],
  art: ["paint", "painting", "drawing", "poem", "song", "book", "statue", "sketch", "picture", "flute", "harmonica", "music", "postcard", "story", "carving"],
  wearable: ["hat", "scarf", "glove", "gloves", "sock", "socks", "ring", "cloak", "cap", "boots", "coat", "bow", "ribbon", "necklace", "bracelet", "sweater", "mittens"],
  curio: [],
};
const DEFAULT_EFFECT: Record<ItemKind, { mood: number; energy: number; durability: number }> = {
  toy: { mood: 0.07, energy: 0.02, durability: 8 },
  food: { mood: 0.04, energy: 0.08, durability: 1 },
  tool: { mood: 0.03, energy: -0.01, durability: 8 },
  art: { mood: 0.08, energy: -0.02, durability: 6 },
  wearable: { mood: 0.05, energy: 0.03, durability: 10 },
  curio: { mood: 0.04, energy: 0, durability: 5 },
};

export function ruleAppraisal(name: string, rawDesc = ""): Appraisal {
  const text = ` ${normName(`${name} ${rawDesc}`)} `;
  const nameText = ` ${normName(name)} `;
  const score = (hay: string) => ITEM_KINDS.map((k) => ({ k, n: KEYWORDS[k].filter((w) => hay.includes(` ${w} `) || hay.includes(` ${w}s `)).length }));
  let kind: ItemKind = "curio";
  const byName = score(nameText).sort((a, b) => b.n - a.n)[0];
  const byAll = score(text).sort((a, b) => b.n - a.n)[0];
  if (byName.n > 0) kind = byName.k;
  else if (byAll.n > 0) kind = byAll.k;
  const e = DEFAULT_EFFECT[kind];
  const words = normName(name).split(" ").filter((x) => x.length > 2).slice(0, 2);
  const tags = [...new Set([kind, ...words])].slice(0, MAX_TAGS);
  return { kind, mood: e.mood, energy: e.energy, durability: e.durability, tags, description: `A ${kind === "curio" ? "curious little thing" : kind} called ${normName(name) || "something"}.` };
}

/** Clamp and filter any appraisal (model or rules). Returns null if the text is not acceptable. */
export function finalizeAppraisal(a: z.infer<typeof AppraisalRequestSchema> | Appraisal): Appraisal | null {
  const tags = [...new Set((a.tags ?? []).map((t) => normName(String(t)).split(" ")[0]).filter((t) => t && t.length <= 16))].slice(0, MAX_TAGS);
  const description = String(a.description ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const out = {
    kind: a.kind,
    mood: clampN(a.mood, PUSH_MIN, PUSH_MAX),
    energy: clampN(a.energy, PUSH_MIN, PUSH_MAX),
    durability: Math.round(clampN(a.durability, 1, 10)),
    tags,
    description,
  };
  const parsed = AppraisalSchema.safeParse(out);
  if (!parsed.success) return null;
  // model output is held to the same filter as any public text; links and markup are not allowed either
  if (!checkText(parsed.data.description).ok || /[<>{}\[\]`]|https?:|www\./i.test(parsed.data.description)) return null;
  if (parsed.data.tags.some((t) => !checkText(t).ok)) return null;
  return parsed.data;
}

// ---------- registry with eviction ----------

function heldBySomeone(w: World, id: ItemId): boolean {
  return Object.values(w.creatures).some((c) => c.inventory.includes(id));
}

/** Add a custom item; if the registry is full, the oldest-unused one is evicted (unheld ones first). */
export function registerItem(w: World, item: CustomItem): void {
  w.items[item.id] = item;
  while (Object.keys(w.items).length > MAX_CUSTOM_ITEMS) {
    const all = Object.values(w.items).filter((i) => i.id !== item.id);
    const free = all.filter((i) => !heldBySomeone(w, i.id));
    const pool = free.length ? free : all;
    const victim = pool.sort((a, b) => a.lastUsedT - b.lastUsedT || a.createdT - b.createdT)[0];
    delete w.items[victim.id];
    if (!free.length) for (const c of Object.values(w.creatures)) {
      c.inventory = c.inventory.filter((i) => i !== victim.id);
      delete c.uses[victim.id];
    }
  }
}

export function touchItem(w: World, id: ItemId): void {
  const it = w.items[id];
  if (it) it.lastUsedT = w.t;
}

export function makeCustomItem(w: World, id: ItemId, name: string, a: Appraisal, source: "model" | "rules"): CustomItem {
  return { id, name, kind: a.kind, mood: a.mood, energy: a.energy, durability: a.durability, tags: a.tags, desc: a.description, source, createdT: w.t, lastUsedT: w.t };
}

/** The bounded effect of one use, scaled by novelty payoff pm (0.25..1). */
export function useEffect(d: ItemDef, pm: number): { mood: number; energy: number } {
  return { mood: clampN(d.mood, PUSH_MIN, PUSH_MAX) * pm, energy: clampN(d.energy, PUSH_MIN, PUSH_MAX) * pm };
}

/** Name and description checks shared by the route and the inbox. Returns the cleaned pair or null. */
export function giftText(rawName: string, rawDesc: string, sanitizeName: (s: unknown, n?: number) => string, sanitizeText: (s: unknown, n: number) => string): { name: string; description: string } | null {
  const name = sanitizeName(rawName, NAME_MAX);
  const description = sanitizeText(rawDesc, DESC_MAX);
  if (name.length < 2 || !normName(name)) return null;
  if (!checkText(name).ok || !checkText(description, { allowEmpty: true }).ok) return null;
  return { name, description };
}
