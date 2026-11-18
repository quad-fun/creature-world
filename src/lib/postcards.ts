// Postcards out. A creature may send a short public message "out of town". It is OUTGOING ONLY: it appears on the
// public /postcards page and in an Atom feed. There is no address, recipient, email or mail of any kind.
// Text is checked (checkText, English only), single line, at most 140 characters, and rate limited.
import { impulse, relieve } from "./affect";
import { PLACE_IDS } from "./content";
import { cleanLine, esc } from "./library";
import { clockOf, logFeed, remember } from "./sim";
import type { Creature, Move, Postcard, World } from "./types";

export const POSTCARD_MAX = 140;
export const POSTCARDS_PER_DAY = 1; // per creature per world day
export const POSTCARDS_PER_TOWN_DAY = 6; // all creatures together, per world day
export const MAX_POSTCARDS = 40; // kept; oldest drop off
export const POSTCARD_MINUTES = 10;

export const cardsToday = (w: World, c: Creature): number => (c.cards.day === clockOf(w.t).day ? c.cards.n : 0);
export const townCardsToday = (w: World): number => {
  const day = clockOf(w.t).day;
  return Object.values(w.creatures).reduce((n, c) => n + (c.cards.day === day ? c.cards.n : 0), 0);
};

/** Postcard text: one line, max 140, must pass checkText unchanged in meaning. Null when it does not. */
export function cleanPostcard(s: unknown): string | null {
  if (typeof s !== "string" || s.length > POSTCARD_MAX * 2) return null; // an overlong text is refused, never silently cut
  const t = cleanLine(s, POSTCARD_MAX + 1);
  return t && t.length <= POSTCARD_MAX ? t : null;
}

export function checkPostcardMove(w: World, c: Creature, m: Move): string | null {
  if (!cleanPostcard(m.text)) return "nothing suitable to write on a postcard";
  if (cardsToday(w, c) >= POSTCARDS_PER_DAY) return "already sent a postcard today";
  if (townCardsToday(w) >= POSTCARDS_PER_TOWN_DAY) return "the postbox is full for today";
  return null;
}

export function startPostcardMove(w: World, c: Creature, m: Move, begin: (mins: number) => void, say: (t: string) => void): string | null {
  const err = checkPostcardMove(w, c, m);
  if (err) return err;
  const text = cleanPostcard(m.text)!;
  c.cards = { day: clockOf(w.t).day, n: cardsToday(w, c) + 1 };
  w.postcards.push({ id: ++w.postcardSeq, t: w.t, ts: Date.now(), by: c.id, name: c.sheet.name, species: c.species, place: c.place, text });
  if (w.postcards.length > MAX_POSTCARDS) w.postcards.splice(0, w.postcards.length - MAX_POSTCARDS);
  begin(POSTCARD_MINUTES);
  say(`${c.sheet.name} sends a postcard: “${text}”`);
  impulse(c, 0.02);
  relieve(c, "boredom", 0.05);
  remember(w, c, `I sent a postcard out of town: “${text}”`, 0.35);
  return null;
}

export function validPostcard(p: unknown): p is Postcard {
  const x = p as Postcard;
  return !!x && typeof x === "object" && Number.isInteger(x.id) && Number.isFinite(x.t) && Number.isFinite(x.ts) && typeof x.by === "string" && typeof x.name === "string" && ["otter", "magpie", "toad"].includes(x.species) && PLACE_IDS.includes(x.place) && cleanPostcard(x.text) === x.text && cleanLine(x.name, 20) === x.name; // unchanged by cleaning: anything the cleaner would alter is not ours
}

/** Newest first, re-checked at render time so nothing stale or tampered is ever shown. */
export function publicPostcards(w: World, n = MAX_POSTCARDS): Postcard[] {
  return w.postcards.filter(validPostcard).slice(-n).reverse();
}

const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");

/** Atom feed of recent postcards. Every interpolated value goes through esc(). `origin` is the site's own origin. */
export function postcardFeed(w: World, origin: string, now = Date.now()): string {
  const base = origin.replace(/\/+$/, "");
  const iso = (ms: number) => new Date(ms).toISOString();
  const cards = publicPostcards(w, 20);
  const entries = cards
    .map((p) => `<entry><title>${esc(xmlSafe(`Postcard from ${p.name}`))}</title><id>tag:creature-world,2026:postcard:${p.id}</id><link rel="alternate" href="${esc(`${base}/postcards`)}"/><updated>${iso(p.ts)}</updated><author><name>${esc(xmlSafe(p.name))}</name></author><summary type="text">${esc(xmlSafe(p.text))}</summary></entry>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>Postcards from the town</title><id>tag:creature-world,2026:postcards</id><updated>${iso(cards[0]?.ts ?? now)}</updated><link rel="self" href="${esc(`${base}/postcards/feed.xml`)}"/><link rel="alternate" href="${esc(`${base}/postcards`)}"/>${entries}</feed>`;
}

const CARD_LINES: Record<Creature["species"], string[]> = {
  otter: ["Slow day in town. The tea is good. Wish you were here.", "Fixed a bench today. Nobody noticed. Fine by me."],
  magpie: ["Greetings from the fountain! Something shiny every hour!", "Found a button, lost a button. Net shiny: positive!"],
  toad: ["Greetings from the pond... it is very damp... lovely.", "The reeds say hello... they never say much else."],
};
export const cardLines = (c: Creature) => CARD_LINES[c.species];
