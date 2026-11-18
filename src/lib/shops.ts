// Creature shops. A shop is DATA on a creature's site: a title, a tagline and up to 4 listings, each pointing at an item
// the creature holds or a work on its shelf, with an in-world price (integer 1..50). No HTML, scripts or links: the
// pages render it with React. A new shop is invisible until a human approves it. Visitors buy with a small, capped
// daily allowance of "visitor coins" (a closed in-world loop, see docs/SHOPS.md); this file never touches credits or
// any payment code. A sale moves coins from that allowance to the creature, so visitor coins are a bounded money
// source and the caps below are what bound it.
import { addInfluence, relieve, impulse } from "./affect";
import { checkText } from "./filter";
import { isGear } from "./goods";
import { itemDef, matchItemId } from "./items";
import { noteExposure, novelty, payoffScale } from "./novelty";
import { own } from "./own";
import { cleanLine } from "./library";
import { logFeed, remember } from "./sim";
import type { Creature, InboxItem, Listing, Move, Receipt, Shop, World } from "./types";

export const SHOP_COST = 5; // coins held while the shop is pending; refunded if it never opens
export const MAX_OPEN_SHOPS = 3;
export const MAX_PENDING_SHOPS = 6; // pending shops plus pending text edits
export const MAX_LISTINGS = 4;
export const PRICE_MIN = 1;
export const PRICE_MAX = 50;
export const SHOP_TITLE_MAX = 40;
export const SHOP_TAGLINE_MAX = 80;
export const SHOP_PENDING_LIFETIME = 3 * 1440; // world minutes: an unanswered shop or edit lapses
export const OPEN_EXPIRES = Number.MAX_SAFE_INTEGER; // an open shop does not lapse
export const SHOP_MINUTES = 20;
export const SHOP_ENERGY = 0.04;

// Visitor-side money: all bounds are applied again under the world lock in applyPurchase.
export const VISITOR_DAILY_COINS = 50; // allowance per visitor (per IP) per real UTC day
export const BUYS_PER_VISITOR_DAY = 3;
export const SHOP_SALES_PER_DAY = 3; // per shop per real UTC day
export const TOWN_SALES_PER_DAY = 8;
export const TOWN_COINS_PER_DAY = 60; // hard ceiling on visitor coins entering the town per day
export const RECEIPTS_KEPT = 40;

export const utcDayStr = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const worldDay = (w: World) => Math.floor(w.t / 1440) + 1;

/** Plain one-line text: ASCII letters, digits, space and , . ' ! ? - only; no double spaces; then checkText. Null when it fails (never rewritten). */
export function cleanShopText(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t || t.length > max || !/^[A-Za-z0-9 ,.'!?-]+$/.test(t) || /\s{2,}/.test(t)) return null;
  return checkText(t).ok ? t : null;
}

/** What may be sold: food and curios the creature carries, never gear (caps live on gear) or seed packets. */
export const isSellable = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 60 && !isGear(id) && id !== "seeds";

export const pendingCount = (w: World) => Object.values(w.creatures).reduce((n, c) => n + (c.shop?.status === "pending" ? 1 : 0) + (c.shop?.draft ? 1 : 0), 0);
export const openCount = (w: World) => Object.values(w.creatures).filter((c) => c.shop?.status === "open").length;

/** Is this listing still real: the item is carried (count respected by the caller) or the work is on the shelf? */
export function backed(c: Creature, l: Listing): boolean {
  if (l.item !== undefined) return isSellable(l.item) && c.inventory.includes(l.item);
  return l.work !== undefined && c.shelf.some((k) => k.n === l.work);
}

/** Raw listings (model output or JSON) -> clean listings. Anything off voids the whole set (null). Items are resolved by `resolve`. */
export function normalizeListings(raw: unknown, resolve: (s: string) => string | undefined): { item?: string; work?: number; price: number }[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LISTINGS) return null;
  const out: { item?: string; work?: number; price: number }[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    const o = e as Record<string, unknown>;
    const price = o.price;
    if (typeof price !== "number" || !Number.isInteger(price) || price < PRICE_MIN || price > PRICE_MAX) return null;
    const hasItem = typeof o.item === "string" && o.item.trim() !== "";
    const hasWork = typeof o.work === "number";
    if (hasItem === hasWork) return null; // exactly one reference
    if (hasWork) {
      const n = o.work as number;
      if (!Number.isInteger(n) || n <= 0) return null;
      out.push({ work: n, price });
    } else {
      const id = resolve(String(o.item).slice(0, 40));
      if (!id || !isSellable(id)) return null;
      out.push({ item: id, price });
    }
  }
  return out;
}
export const listingResolver = (w: World) => (s: string) => matchItemId(w, s, { goods: true });

/**
 * Shared checks for opening or editing a shop. Normalises the move (clean text, listings) and returns a reason or null.
 * Used while planning (projected place, items, coins) and again when starting (real state).
 */
function shopError(w: World, c: Creature, m: Move, place: string, inv: string[], coins: number, site: boolean): string | null {
  if (place !== "workshop") return "shops are set up at the workshop";
  if (!site) return "needs a website first";
  if (c.energy <= 0.3) return "too tired to set up a shop";
  if (c.shopDay === worldDay(w)) return "already worked on the shop today";
  const existing = c.shop;
  const title = cleanShopText(m.title, SHOP_TITLE_MAX) ?? existing?.title ?? cleanShopText(`${c.sheet.name}'s shop`, SHOP_TITLE_MAX);
  const tagline = cleanShopText(m.text, SHOP_TAGLINE_MAX) ?? existing?.tagline ?? "Small things, fairly priced.";
  if (!title || !tagline) return "the shop name is not allowed";
  const listings = normalizeListings(m.listings, listingResolver(w));
  if (!listings) return `a shop needs 1 to ${MAX_LISTINGS} listings, each with a held item or a work and a price of ${PRICE_MIN} to ${PRICE_MAX} coins`;
  const held = new Map<string, number>();
  for (const i of inv) held.set(i, (held.get(i) ?? 0) + 1);
  const seen = new Set<string>();
  for (const l of listings) {
    if (l.item !== undefined) {
      const left = held.get(l.item) ?? 0;
      if (left <= 0) return "can only list something I carry";
      held.set(l.item, left - 1);
    } else {
      const key = `w${l.work}`;
      if (seen.has(key) || !c.shelf.some((k) => k.n === l.work)) return "can only list a work on my shelf, once";
      seen.add(key);
    }
  }
  if (!existing) {
    if (coins < SHOP_COST) return `a shop costs ${SHOP_COST} coins to set up`;
    if (pendingCount(w) >= MAX_PENDING_SHOPS) return "too many shops are waiting for an answer";
  } else if (existing.status === "open" && (title !== existing.title || tagline !== existing.tagline) && !existing.draft && pendingCount(w) >= MAX_PENDING_SHOPS) {
    return "too many shops are waiting for an answer";
  }
  m.title = title;
  m.text = tagline;
  m.listings = listings;
  return null;
}

export interface ShopProj {
  place: string;
  coins: number;
  inv: string[];
  site: boolean;
}
export function checkShopMove(w: World, c: Creature, m: Move, p: ShopProj): string | null {
  const err = shopError(w, c, m, p.place, p.inv, p.coins, p.site);
  if (err) return err;
  if (!c.shop) p.coins -= SHOP_COST;
  return null;
}

export function startShopMove(w: World, c: Creature, m: Move, begin: (mins: number) => void, say: (t: string) => void): string | null {
  const err = shopError(w, c, m, c.place, c.inventory, c.coins, !!c.site);
  if (err) return err;
  if (!c.shop) c.coins -= SHOP_COST;
  c.shopDay = worldDay(w);
  c.energy = Math.max(0.04, c.energy - SHOP_ENERGY);
  begin(SHOP_MINUTES);
  say(c.shop ? `${c.sheet.name} rearranges the shop.` : `${c.sheet.name} starts setting up a shop.`);
  return null;
}

/** The activity ran its course: write the shop (or the edit) into the world. */
export function finishShopMove(w: World, c: Creature, m: Move): void {
  const title = cleanShopText(m.title, SHOP_TITLE_MAX);
  const tagline = cleanShopText(m.text, SHOP_TAGLINE_MAX);
  const held = new Map<string, number>();
  for (const i of c.inventory) held.set(i, (held.get(i) ?? 0) + 1);
  const listings = (normalizeListings(m.listings, (s) => s) ?? []).filter((l) => {
    if (l.item !== undefined) {
      const left = held.get(l.item) ?? 0;
      held.set(l.item, left - 1);
      return left > 0;
    }
    return c.shelf.some((k) => k.n === l.work);
  });
  const name = c.sheet.name;
  const old = c.shop;
  if (!title || !tagline || !listings.length) {
    if (!old) c.coins += SHOP_COST; // nothing to set up after all: the coins come back
    return;
  }
  let seq = old?.listingSeq ?? 0;
  const fresh: Listing[] = listings.map((l) => ({ ...l, id: ++seq }));
  if (!old) {
    c.shop = { title, tagline, status: "pending", listings: fresh, listingSeq: seq, createdT: w.t, expiresT: w.t + SHOP_PENDING_LIFETIME, paid: SHOP_COST, sales: { day: "", n: 0 }, sold: 0 };
    logFeed(w, c.id, "move", `${name} sets up a shop, “${title}”; it waits for the town's approval.`);
    remember(w, c, `I asked to open a shop called “${title}”. I am waiting to hear.`, 0.5);
    return;
  }
  old.listings = fresh;
  old.listingSeq = seq;
  if (old.status === "pending") {
    old.title = title;
    old.tagline = tagline;
  } else if (title !== old.title || tagline !== old.tagline) {
    old.draft = { title, tagline, expiresT: w.t + SHOP_PENDING_LIFETIME }; // new words wait for a human; the old words stay up
    logFeed(w, c.id, "move", `${name} rewrites the words on the shop; the new words wait for approval.`);
    return;
  }
  logFeed(w, c.id, "move", `${name} puts new things out in the shop.`);
}

/** Hourly: lapse unanswered shops and edits (refunded), and drop listings that are no longer backed. */
export function sweepShops(w: World): void {
  for (const c of Object.values(w.creatures)) {
    const s = c.shop;
    if (!s) continue;
    if (s.status === "pending" && w.t >= s.expiresT) {
      c.coins += s.paid;
      c.shop = null;
      logFeed(w, "world", "system", `${c.sheet.name}'s proposed shop lapsed without an answer.`);
      continue;
    }
    if (s.draft && w.t >= s.draft.expiresT) {
      delete s.draft;
      logFeed(w, "world", "system", `New words for ${c.sheet.name}'s shop lapsed; the old words stay.`);
    }
    const inv = new Map<string, number>();
    for (const i of c.inventory) inv.set(i, (inv.get(i) ?? 0) + 1);
    s.listings = s.listings.filter((l) => {
      if (l.item === undefined) return backed(c, l);
      const left = inv.get(l.item) ?? 0;
      inv.set(l.item, left - 1);
      return left > 0 && isSellable(l.item);
    });
  }
}

// ---------- the human queue ----------

export type ShopAction = "approve" | "reject" | "remove";
type FeedFn = (w: World, who: string, kind: "system", text: string) => void;

export function adminShopAct(w: World, action: unknown, id: unknown, log: FeedFn): { ok: true; message: string } | { ok: false; error: string; status: number } {
  if (action !== "approve" && action !== "reject" && action !== "remove") return { ok: false, error: "unknown action", status: 400 };
  if (typeof id !== "string") return { ok: false, error: "creature must be a string", status: 400 };
  const c = own(w.creatures, id);
  const s = c?.shop;
  if (!c || !s) return { ok: false, error: "no such shop", status: 404 };
  const name = `${c.sheet.name}'s shop`;
  if (action === "approve") {
    if (s.draft) {
      s.title = s.draft.title;
      s.tagline = s.draft.tagline;
      delete s.draft;
      log(w, "world", "system", `New words for ${name} were approved.`);
      return { ok: true, message: "edit approved" };
    }
    if (s.status !== "pending") return { ok: false, error: "not pending", status: 409 };
    if (openCount(w) >= MAX_OPEN_SHOPS) return { ok: false, error: "the town is at its cap of open shops; remove one first", status: 409 };
    s.status = "open";
    s.expiresT = OPEN_EXPIRES;
    log(w, "world", "system", `${name} was approved and is open.`);
    return { ok: true, message: "approved" };
  }
  if (action === "reject") {
    if (s.draft) {
      delete s.draft;
      log(w, "world", "system", `New words for ${name} were turned down.`);
      return { ok: true, message: "edit rejected" };
    }
    if (s.status !== "pending") return { ok: false, error: "not pending (use remove)", status: 409 };
    c.coins += s.paid; // it never opened: refunded once, the record is deleted in the same step
    c.shop = null;
    log(w, "world", "system", `A proposed shop (${name}) was turned down.`);
    return { ok: true, message: "rejected and refunded" };
  }
  if (s.status !== "open") return { ok: false, error: "not open (use reject)", status: 409 };
  c.shop = null; // it stood: no refund
  log(w, "world", "system", `${name} was closed.`);
  return { ok: true, message: "removed, no refund" };
}

export const adminShops = (w: World) =>
  Object.values(w.creatures)
    .filter((c) => c.shop)
    .map((c) => {
      const s = c.shop!;
      return { creature: c.id, name: c.sheet.name, title: s.title, tagline: s.tagline, status: s.status, draft: s.draft ?? null, listings: s.listings, paid: s.paid, sold: s.sold, createdT: s.createdT, expiresT: s.status === "pending" ? s.expiresT : null };
    });

// ---------- public projection ----------

export interface PublicListing {
  id: number;
  label: string;
  kind: "item" | "work";
  price: number;
}
export interface PublicShop {
  id: string;
  name: string;
  emoji: string;
  title: string;
  tagline: string;
  listings: PublicListing[];
}

export function publicShop(w: World, c: Creature): PublicShop | null {
  const s = c.shop;
  if (!s || s.status !== "open" || !c.site) return null;
  const title = cleanShopText(s.title, SHOP_TITLE_MAX);
  const tagline = cleanShopText(s.tagline, SHOP_TAGLINE_MAX);
  if (!title || !tagline) return null;
  const listings: PublicListing[] = [];
  const inv = new Map<string, number>();
  for (const i of c.inventory) inv.set(i, (inv.get(i) ?? 0) + 1);
  for (const l of s.listings.slice(0, MAX_LISTINGS)) {
    if (!Number.isInteger(l.price) || l.price < PRICE_MIN || l.price > PRICE_MAX) continue;
    if (l.item !== undefined) {
      const left = inv.get(l.item) ?? 0;
      inv.set(l.item, left - 1);
      if (left <= 0 || !isSellable(l.item)) continue;
      const label = cleanLine(itemDef(w, l.item).name, 40);
      if (label) listings.push({ id: l.id, label, kind: "item", price: l.price });
    } else {
      const k = c.shelf.find((x) => x.n === l.work);
      const label = k && cleanLine(k.title, 60);
      if (label) listings.push({ id: l.id, label, kind: "work", price: l.price });
    }
  }
  return { id: c.id, name: c.sheet.name, emoji: c.emoji, title, tagline, listings };
}
export const publicShops = (w: World): PublicShop[] => Object.values(w.creatures).map((c) => publicShop(w, c)).filter((s): s is PublicShop => !!s);

// ---------- buying (applied under the world lock from the inbox) ----------

export interface Refund {
  key: string;
  coins: number;
}
const TOKEN_RE = /^[a-f0-9]{12}$/;
export const isToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);
export const findReceipt = (w: World, token: unknown): Receipt | undefined => (isToken(token) ? (w.receipts ?? []).find((r) => r.token === token) : undefined);

function addReceipt(w: World, token: string, ok: boolean, text: string, now: number) {
  w.receipts ??= [];
  w.receipts.push({ token, ok, text, ts: now });
  if (w.receipts.length > RECEIPTS_KEPT) w.receipts.splice(0, w.receipts.length - RECEIPTS_KEPT);
}

/** Apply one purchase. Returns a refund of the visitor's reserved coins when it fails; never throws on hostile data. */
export function applyPurchase(w: World, it: Extract<InboxItem, { type: "purchase" }>, now = Date.now()): Refund | null {
  if (!isToken(it.token) || typeof it.vkey !== "string" || !it.vkey.startsWith("vcoins:") || it.vkey.length > 120) return null; // not from our route: nothing to refund
  if (findReceipt(w, it.token)) return null; // replay of an applied token
  const paid = it.paid;
  if (typeof paid !== "number" || !Number.isInteger(paid) || paid < PRICE_MIN || paid > PRICE_MAX) return null;
  const refund: Refund = { key: it.vkey, coins: paid };
  const fail = (why: string): Refund => {
    addReceipt(w, it.token, false, `Not sold: ${why}. Your visitor coins were returned.`, now);
    return refund;
  };
  const c = own(w.creatures, it.creature);
  const s = c?.shop;
  if (!c || !s || s.status !== "open" || !c.site) return fail("that shop is closed");
  if (typeof it.listing !== "number" || !Number.isInteger(it.listing)) return fail("that listing is gone");
  const l = s.listings.find((x) => x.id === it.listing);
  if (!l || !backed(c, l)) return fail("that listing is gone");
  if (l.price !== paid) return fail("the price changed");
  const day = utcDayStr(now);
  if (w.shopDay?.day !== day) w.shopDay = { day, n: 0, coins: 0 };
  if (s.sales.day !== day) s.sales = { day, n: 0 };
  if (s.sales.n >= SHOP_SALES_PER_DAY) return fail("this shop has sold enough for today");
  if (w.shopDay.n >= TOWN_SALES_PER_DAY || w.shopDay.coins + l.price > TOWN_COINS_PER_DAY) return fail("the town market is quiet for today");

  let what: string;
  if (l.item !== undefined) {
    const i = c.inventory.indexOf(l.item);
    if (i < 0) return fail("that listing is gone");
    what = cleanLine(itemDef(w, l.item).name, 40) ?? "a small thing";
    c.inventory.splice(i, 1);
    s.listings.splice(s.listings.indexOf(l), 1); // an item is sold once
  } else {
    const k = c.shelf.find((x) => x.n === l.work);
    what = `“${cleanLine(k?.title, 60) ?? "a work"}”`; // a work stays on the shelf: the buyer gets a copy
  }
  c.coins += l.price;
  s.sales.n++;
  s.sold++;
  w.shopDay.n++;
  w.shopDay.coins += l.price;
  const nov = novelty(c, "shop:sale", w.t);
  noteExposure(c, "shop:sale", w.t);
  const pm = payoffScale(nov);
  addInfluence(c, "accomplishment", "made a sale at my shop", 0.35 * pm);
  addInfluence(c, "joy", "a visitor bought something", 0.2 * pm);
  relieve(c, "boredom", 0.15 * nov);
  impulse(c, 0.04 * pm, 0.02);
  remember(w, c, `A visitor bought ${what} from my shop for ${l.price} coins.`, 0.6);
  logFeed(w, c.id, "move", `A visitor buys ${what} from ${c.sheet.name}'s shop for ${l.price} coins.`);
  addReceipt(w, it.token, true, `Receipt: ${what} from ${c.sheet.name}'s shop, ${l.price} visitor coins.`, now);
  return null;
}

// ---------- rules mind and prompt ----------

const FIRST_TAGLINE = "Small things, fairly priced.";

/** Items worth listing first: not food (the creature eats it), not gear. Then works, newest first. Prices are modest. */
function stock(w: World, c: Creature, taken: Set<string>, count: Map<string, number>): { item?: string; work?: number; price: number }[] {
  const out: { item?: string; work?: number; price: number }[] = [];
  const left = new Map(count);
  for (const i of c.inventory) {
    if (out.length >= MAX_LISTINGS) break;
    const d = itemDef(w, i);
    if (!isSellable(i) || d.food > 0 || (left.get(i) ?? 0) <= 0 || taken.has(`i:${i}`)) continue;
    left.set(i, (left.get(i) ?? 0) - 1);
    out.push({ item: i, price: Math.max(PRICE_MIN, Math.min(PRICE_MAX, d.sell + 1)) });
  }
  for (const k of [...c.shelf].reverse()) {
    if (out.length >= MAX_LISTINGS) break;
    if (taken.has(`w:${k.n}`)) continue;
    out.push({ work: k.n, price: k.kind === "drawing" ? 5 : 3 });
  }
  return out;
}

/** Rules mind: open a shop (once the site exists) or put out more stock. Both are low-want options scored by novelty. */
export function ruleShopOption(w: World, c: Creature): { want: number; moves: Move[]; key: string } | null {
  if (!c.site || c.energy <= 0.45 || c.shopDay === worldDay(w)) return null;
  const s = c.shop;
  if (s?.status === "pending") return null;
  const count = new Map<string, number>();
  for (const i of c.inventory) count.set(i, (count.get(i) ?? 0) + 1);
  const taken = new Set<string>();
  for (const l of s?.listings ?? []) if (backed(c, l)) taken.add(l.item !== undefined ? `i:${l.item}` : `w:${l.work}`);
  if (!s && c.coins < SHOP_COST + 10) return null; // never from the last coins
  if (s && s.listings.length >= MAX_LISTINGS) return null;
  const listings = stock(w, c, taken, count);
  if (!listings.length) return null;
  // a relist keeps what is already on sale, up to the cap
  const keep = (s?.listings ?? []).filter((l) => backed(c, l)).map((l) => ({ item: l.item, work: l.work, price: l.price }));
  const all = [...keep, ...listings].slice(0, MAX_LISTINGS).map((l) => (l.item !== undefined ? { item: l.item, price: l.price } : { work: l.work, price: l.price }));
  const move: Move = { do: "open_shop", title: s?.title ?? `${c.sheet.name}'s shop`, text: s?.tagline ?? FIRST_TAGLINE, listings: all, why: s ? "I have more to put out in the shop." : "I could sell some of what I make from my own shop." };
  const trial = { place: "workshop", coins: c.coins, inv: [...c.inventory], site: true };
  if (checkShopMove(w, c, { ...move }, trial)) return null;
  const walk: Move[] = c.place === "workshop" ? [] : [{ do: "walk", place: "workshop", why: "The shop is set up at the workshop." }];
  return { want: s ? 0.22 : 0.3, moves: [...walk, move], key: s ? "shop:relist" : "shop:open" };
}

/** One prompt line about shops, for the decision prompt. */
export function shopNote(w: World, c: Creature): string {
  const s = c.shop;
  const state = !c.site
    ? "You need a website first."
    : !s
      ? `You could open a shop for ${SHOP_COST} coins.`
      : s.status === "pending"
        ? "Your shop is waiting for the town's approval."
        : `Your shop is open (${s.listings.length} listings, ${s.sold} sold).`;
  return `- open_shop: only at the workshop, needs a website. title (max ${SHOP_TITLE_MAX} plain characters) and text (a tagline, max ${SHOP_TAGLINE_MAX}) name your shop; listings is 1 to ${MAX_LISTINGS} entries, each with item (something you carry that is not gear) or work (a work number on your shelf) and an integer price of ${PRICE_MIN} to ${PRICE_MAX} coins. Visitors pay with in-world visitor coins; you cannot name anyone or write links. A new shop and new words wait for the town's approval and may be turned down; changing only items or prices is automatic. Once a day. ${state}`;
}
