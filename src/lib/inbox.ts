// What the outside world can do to the town: leave a note, give a treat, adopt a creature.
// Everything is sanitised here, applied by the tick engine under its lock, and visible in the feed.
// Nothing from outside can touch a creature's drives, sheet or locked lines directly.
import { appraise, impulse, relieve } from "./affect";
import { checkAll, checkText, stripInvisible } from "./filter";
import { ITEMS, MAX_CREATURES, SPECIES_EMOJI, base } from "./content";
import { customId, giftText, itemDef, matchItemId, normName, touchItem } from "./items";
import { MAX_CARRY, logFeed, remember, touchBond } from "./sim";
import { noteExposure, novelty, payoffScale } from "./novelty";
import { own } from "./own";
import type { InboxItem, World } from "./types";

const URL_RE = /(https?:\/\/|www\.)\S+/gi;

/** Plain, short, single-line text with no markup and no links. */
export function sanitizeText(s: unknown, max: number): string {
  if (typeof s !== "string") return ""; // arrays, objects, numbers: not text
  return stripInvisible(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(URL_RE, "")
    .replace(/[<>`{}\[\]\\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

export function sanitizeName(s: unknown, max = 20): string {
  if (typeof s !== "string") return "";
  return stripInvisible(s)
    .replace(/[^\p{L}\p{N} '-]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

export function sanitizeList(xs: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(xs)) return [];
  return xs.map((x) => sanitizeText(x, maxLen).toLowerCase()).filter(Boolean).slice(0, maxItems);
}

function pushBoard(w: World, by: string, byKind: "creature" | "visitor", text: string, to?: string) {
  w.board.push({ id: ++w.boardSeq, t: w.t, ts: Date.now(), by, byKind, to, text });
  if (w.board.length > 60) w.board.splice(0, w.board.length - 60);
}

/** Apply a drained batch. One malformed item (whatever is in Redis) is skipped; it never stops the rest or the tick. */
export function applyInbox(w: World, items: InboxItem[]) {
  for (const it of items) {
    try {
      applyOne(w, it);
    } catch (e) {
      console.error("inbox item skipped", (e as Error)?.message);
    }
  }
}

function applyOne(w: World, it: InboxItem) {
  {
    if (!it || typeof it !== "object") return;
    if (it.type === "note") {
      const c = own(w.creatures, it.to);
      const from = sanitizeName(it.from) || "a visitor";
      const text = sanitizeText(it.text, 200);
      if (!c || !text || !checkText(text).ok || !checkText(from, { allowEmpty: true }).ok) return;
      c.heard.push({ t: w.t, from: `${from} (a visitor)`, text });
      if (c.heard.length > 6) c.heard.shift();
      impulse(c, 0.03 + appraise(c, [], text) * 0.3, 0.05);
      relieve(c, "loneliness", 0.1);
      remember(w, c, `A visitor named ${from} told me: “${text}”`, 0.55);
      pushBoard(w, from, "visitor", text, c.sheet.name);
      logFeed(w, c.id, "say", `${from} (a visitor) leaves a note for ${c.sheet.name}: “${text}”`);
    } else if (it.type === "treat") {
      const c = own(w.creatures, it.to);
      const from = sanitizeName(it.from) || "a visitor";
      if (!c) return;
      if (c.inventory.length < 5) c.inventory.push("bread");
      impulse(c, 0.05 + appraise(c, ITEMS.bread.tags) * 0.3, 0.05);
      remember(w, c, `A visitor named ${from} left me a loaf of bread.`, 0.6);
      logFeed(w, c.id, "move", `${from} (a visitor) leaves a loaf of bread for ${c.sheet.name}.`);
    } else if (it.type === "gift") {
      // The item must already be in the registry (appraiseGifts runs first); the raw description is gone by now.
      const c = own(w.creatures, it.to);
      const from = sanitizeName(it.from) || "a visitor";
      const t = giftText(it.name, it.description, sanitizeName, sanitizeText);
      if (!c || !t || !checkText(from, { allowEmpty: true }).ok) return;
      const id = matchItemId(w, t.name) ?? (w.items[customId(normName(t.name))] ? customId(normName(t.name)) : undefined);
      if (!id) return;
      const d = itemDef(w, id);
      if (c.inventory.length >= MAX_CARRY) {
        logFeed(w, c.id, "move", `${from} (a visitor) offers ${c.sheet.name} ${d.name}, but ${c.sheet.name}'s hands are full.`);
        return;
      }
      c.inventory.push(id);
      touchItem(w, id);
      const pm = payoffScale(novelty(c, `item:${id}`, w.t));
      noteExposure(c, `item:${id}`, w.t);
      impulse(c, (0.05 + appraise(c, [...d.tags, "gift"]) * 0.3) * pm, 0.05);
      remember(w, c, `A visitor named ${from} gave me ${d.name}${d.desc ? `: ${d.desc}` : "."}`, 0.6);
      logFeed(w, c.id, "move", `${from} (a visitor) gives ${c.sheet.name} ${d.name}.`);
    } else if (it.type === "adopt") {
      if (Object.keys(w.creatures).length >= MAX_CREATURES) return;
      if (![it.temperament, it.likes, it.dislikes].every(Array.isArray)) return; // only ever arrays from our routes; guards a tampered queue
      const name = sanitizeName(it.name);
      if (name.length < 2 || !Object.hasOwn(SPECIES_EMOJI, it.species)) return;
      if (!checkText(name).ok || checkAll([...it.temperament, ...it.likes, ...it.dislikes, it.voice ?? ""])) return;
      if (Object.values(w.creatures).some((o) => o.sheet.name.toLowerCase() === name.toLowerCase())) return;
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "creature";
      while (w.creatures[id]) id += "x";
      const baseline = 0.1 + ((name.length * 7) % 20) / 100; // 0.10..0.29, stable per name
      const c = base(id, it.species, SPECIES_EMOJI[it.species], "nests", baseline, {
        name,
        temperament: it.temperament.slice(0, 3),
        likes: it.likes.slice(0, 5),
        dislikes: it.dislikes.slice(0, 3),
        voice: it.voice || "Plain and friendly.",
        locked: [`${name} never harms another creature.`, `${name} never leaves the town.`],
        self: "I am new in town and still finding out who I am.",
      });
      for (const o of Object.values(w.creatures)) {
        remember(w, o, `${name} the ${it.species} arrived in town.`, 0.5);
        touchBond(o, id, { familiarity: 0.02 });
      }
      w.creatures[id] = c;
      logFeed(w, "world", "system", `${name} the ${it.species} arrives in town, adopted by a visitor.`);
    }
  }
}
