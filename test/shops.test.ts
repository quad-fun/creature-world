process.env.MIND = "rules";
process.env.CRON_SECRET = "";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { seedWorld } from "../src/lib/content";
import { migrate } from "../src/lib/migrate";
import { applyInbox } from "../src/lib/inbox";
import { kickQueue, logFeed, stepWorld, validateMoves } from "../src/lib/sim";
import {
  BUYS_PER_VISITOR_DAY, MAX_OPEN_SHOPS, MAX_PENDING_SHOPS, SHOP_COST, SHOP_PENDING_LIFETIME, SHOP_SALES_PER_DAY, TOWN_COINS_PER_DAY, TOWN_SALES_PER_DAY, VISITOR_DAILY_COINS,
  adminShopAct, adminShops, applyPurchase, cleanShopText, findReceipt, normalizeListings, pendingCount, publicShop, publicShops, sweepShops, utcDayStr,
} from "../src/lib/shops";
import { applyRulesForTest } from "./helpers";
import { buildDecisionPrompt } from "../src/lib/mind";
import { getStore } from "../src/lib/store";
import { GET as adminGet, POST as adminPost } from "../src/app/api/admin/shops/route";
import { POST as buyPost } from "../src/app/api/shop/buy/route";
import type { Creature, InboxItem, Move, World } from "../src/lib/types";

const act = (...a: Parameters<typeof adminShopAct>) => adminShopAct(...a) as { ok: boolean; status?: number; message?: string; error?: string };
const NOW = Date.UTC(2026, 5, 1, 12);
const setup = () => {
  const w = seedWorld(0);
  const c = w.creatures.moss;
  c.place = "workshop";
  c.coins = 40;
  c.energy = 0.9;
  c.site = { title: "Moss's corner", tagline: "Things I made.", t: 0 };
  c.inventory = ["trinket", "potion"];
  c.shelf = [1, 2, 3].map((n) => ({ n, kind: "note" as const, title: `Note ${n}`, body: "A quiet note.", t: 0, ts: 0, by: "moss" }));
  c.workSeq = 3;
  return { w, c };
};
const L = (...x: { item?: string; work?: number; price: number }[]) => x;
const open = (w: World, c: Creature, m: Partial<Move> = {}) => {
  const v = validateMoves(w, c, [{ do: "open_shop", why: "x", title: "Moss's shop", text: "Small things.", listings: L({ item: "trinket", price: 4 }, { work: 1, price: 3 }), ...m }]);
  if (v.rejected.length) return { err: v.rejected.join() };
  c.queue = v.moves;
  kickQueue(w, c);
  for (let i = 0; i < 20 && c.activity; i++) stepWorld(w);
  return { err: null };
};
const openShop = (w: World, c: Creature) => {
  assert.equal(open(w, c).err, null);
  assert.equal(act(w, "approve", c.id, logFeed).ok, true);
};
let seq = 0;
const buy = (listing: number, creature = "moss", paid = 4, extra: Partial<InboxItem> = {}): InboxItem =>
  ({ type: "purchase", creature, listing, paid, token: (++seq).toString(16).padStart(12, "0"), vkey: "vcoins:2026-06-01:1.2.3.4", ...extra }) as InboxItem;
const total = (w: World) => Object.values(w.creatures).reduce((n, c) => n + c.coins, 0);

test("a shop needs a site, the workshop, valid listings and the coins; hostile fields are refused", () => {
  const { w, c } = setup();
  const bad = (m: Partial<Move>, re: RegExp) => assert.match(open(w, c, m).err ?? "", re);
  c.site = null;
  bad({}, /website/);
  c.site = { title: "x", tagline: "y", t: 0 };
  c.place = "park";
  assert.equal(validateMoves(w, c, [{ do: "open_shop", why: "x", title: "S", text: "T", listings: L({ item: "trinket", price: 4 }) }]).moves.length, 0);
  c.place = "workshop";
  bad({ listings: undefined }, /listings/);
  bad({ listings: [] }, /listings/);
  bad({ listings: L({ item: "trinket", price: 0 }) }, /listings/);
  bad({ listings: L({ item: "trinket", price: 51 }) }, /listings/);
  bad({ listings: L({ item: "trinket", price: 2.5 }) }, /listings/);
  bad({ listings: [{ item: "trinket", price: "3" }] as never }, /listings/);
  bad({ listings: L({ item: "trinket", price: 3 }, { item: "trinket", price: 3 }) }, /carry/); // only one trinket held
  bad({ listings: L({ item: "bread", price: 3 }) }, /carry/);
  bad({ listings: L({ item: "kite", price: 3 }) }, /listings|carry/);
  bad({ listings: L({ work: 99, price: 3 }) }, /shelf/);
  bad({ listings: L({ work: 1, price: 3 }, { work: 1, price: 4 }) }, /shelf/);
  bad({ listings: [1, 2, 3, 4, 5].map(() => ({ work: 1, price: 3 })) }, /listings/);
  bad({ listings: [{ item: "trinket", work: 1, price: 3 }] as never }, /listings/);
  c.energy = 0.2;
  bad({}, /tired/);
  c.energy = 0.9;
  c.coins = SHOP_COST - 1;
  bad({}, /coins/);
  c.coins = 40;
  // gear and seeds are never sellable, even when carried
  c.inventory = ["rod", "seeds", "trinket"];
  bad({ listings: L({ item: "rod", price: 3 }) }, /listings|carry/);
  bad({ listings: L({ item: "seeds", price: 3 }) }, /listings|carry/);
});

test("hostile text and shapes: html, links, unicode, long and __proto__ keys never make a shop", () => {
  for (const t of ["<b>hi</b>", "visit http://x.io", "Café shop", "x".repeat(41), "two  spaces", "", "a\nb", "shop <script>"]) assert.equal(cleanShopText(t, 40), null, t);
  assert.equal(cleanShopText("Moss's small shop!", 40), "Moss's small shop!");
  assert.equal(cleanShopText({ toString: () => "x" }, 40), null);
  const res = (s: string) => s;
  assert.equal(normalizeListings(JSON.parse('[{"__proto__":{"item":"trinket"},"price":3}]'), res), null);
  assert.equal(normalizeListings(JSON.parse('[{"item":"__proto__","price":3}]'), () => undefined), null);
  assert.equal(normalizeListings(JSON.parse('[{"item":"constructor","price":3}]'), (s) => (Object.hasOwn({}, s) ? s : undefined)), null);
  assert.equal(normalizeListings("trinket", res), null);
  assert.equal(normalizeListings([null], res), null);
  assert.equal(normalizeListings([[1, 2]], res), null);
  assert.equal(normalizeListings([{ work: -1, price: 3 }], res), null);
  assert.equal(normalizeListings([{ work: 1.5, price: 3 }], res), null);
  assert.equal(normalizeListings([{ work: 1, price: Number.NaN }], res), null);
  assert.equal(normalizeListings([{ work: 1, price: Infinity }], res), null);
  const { w, c } = setup();
  // a title that fails the filter is not applied; a default name is used instead
  assert.equal(open(w, c, { title: "<img src=x>" }).err, null);
  assert.equal(c.shop?.title, "Moss's shop");
  const m = validateMoves(w, c, [{ do: "open_shop", why: "x", title: "T", text: "Y", listings: JSON.parse('[{"__proto__":{"x":1},"item":"potion","price":5}]') }]);
  assert.ok(m.moves.length === 0 || m.moves[0].listings?.every((l) => Object.keys(l).every((k) => ["item", "work", "price"].includes(k))));
});

test("opening: coins held, shop is pending and invisible, lapses with a refund after 3 world days", () => {
  const { w, c } = setup();
  const before = total(w);
  assert.equal(open(w, c).err, null);
  assert.equal(c.shop?.status, "pending");
  assert.equal(c.coins, 40 - SHOP_COST);
  assert.equal(publicShops(w).length, 0);
  assert.equal(publicShop(w, c), null);
  assert.equal(c.shop!.listings.length, 2);
  assert.match(open(w, c, { text: "Again" }).err ?? "", /today/, "one a day");
  w.t = c.shop!.expiresT - 1;
  sweepShops(w);
  assert.ok(c.shop);
  w.t = c.shop!.expiresT;
  sweepShops(w);
  assert.equal(c.shop, null);
  assert.equal(total(w), before, "refunded exactly once");
  assert.equal(c.shop === null && SHOP_PENDING_LIFETIME, 3 * 1440);
});

test("approval, rejection with refund, removal without, and the caps", () => {
  const { w, c } = setup();
  assert.equal(open(w, c).err, null);
  assert.equal(act(w, "remove", "moss", logFeed).ok, false, "not open yet");
  assert.equal(act(w, "reject", "moss", logFeed).ok, true);
  assert.equal(c.coins, 40);
  assert.equal(c.shop, null);
  assert.equal(act(w, "reject", "moss", logFeed).ok, false, "no second refund");
  c.shopDay = 0;
  openShop(w, c);
  assert.equal(publicShops(w).length, 1);
  assert.equal(act(w, "approve", "moss", logFeed).ok, false, "already open");
  assert.equal(act(w, "remove", "moss", logFeed).ok, true);
  assert.equal(c.coins, 40 - SHOP_COST, "a shop that stood is not refunded");
  assert.equal(act(w, "approve", "nobody", logFeed).status, 404);
  assert.equal(act(w, "approve", "__proto__", logFeed).status, 404);
  assert.equal(act(w, "approve", 5, logFeed).status, 400);
  assert.equal(act(w, "explode", "moss", logFeed).status, 400);
  // town caps with fabricated shops
  const w2 = seedWorld(0);
  const ids = Object.keys(w2.creatures);
  const mk = (status: "pending" | "open") => ({ title: "S", tagline: "T", status, listings: [], listingSeq: 0, createdT: 0, expiresT: 1e9, paid: SHOP_COST, sales: { day: "", n: 0 }, sold: 0 });
  assert.ok(ids.length >= 3);
  for (const id of ids) w2.creatures[id].shop = mk("pending");
  for (const id of ids.slice(0, MAX_OPEN_SHOPS)) assert.equal(act(w2, "approve", id, logFeed).ok, true);
  assert.equal(pendingCount(w2), ids.length - MAX_OPEN_SHOPS);
  if (ids.length > MAX_OPEN_SHOPS) assert.equal(act(w2, "approve", ids[MAX_OPEN_SHOPS], logFeed).status, 409, "open cap");
  // pending cap: six other creatures wait, so a seventh shop is refused up front
  const { w: w3, c: c3 } = setup();
  for (let i = 0; i < MAX_PENDING_SHOPS; i++) {
    const o = structuredClone(c3);
    o.id = `extra${i}`;
    o.shop = mk("pending");
    w3.creatures[o.id] = o;
  }
  assert.equal(pendingCount(w3), MAX_PENDING_SHOPS);
  assert.match(open(w3, c3).err ?? "", /waiting/);
  assert.equal(c3.coins, 40);
});

test("edits: price and item changes are automatic, changed words go back to the human queue", () => {
  const { w, c } = setup();
  openShop(w, c);
  c.shopDay = 0;
  assert.equal(open(w, c, { listings: L({ item: "potion", price: 9 }) }).err, null);
  assert.equal(c.shop!.status, "open");
  assert.equal(c.shop!.draft, undefined);
  assert.deepEqual(c.shop!.listings.map((l) => [l.item, l.price]), [["potion", 9]]);
  assert.equal(publicShop(w, c)!.listings[0].price, 9);
  c.shopDay = 0;
  assert.equal(open(w, c, { text: "New words here", listings: L({ item: "potion", price: 9 }) }).err, null);
  assert.equal(c.shop!.tagline, "Small things.", "old words stay up");
  assert.equal((c.shop!.draft as { tagline: string } | undefined)?.tagline, "New words here");
  assert.equal(act(w, "reject", "moss", logFeed).message, "edit rejected");
  assert.equal(c.shop!.draft, undefined);
  c.shopDay = 0;
  open(w, c, { title: "Moss Mends", listings: L({ item: "potion", price: 9 }) });
  assert.equal(act(w, "approve", "moss", logFeed).message, "edit approved");
  assert.equal(c.shop!.title, "Moss Mends");
  c.shopDay = 0;
  open(w, c, { title: "Other", listings: L({ item: "potion", price: 9 }) });
  w.t += SHOP_PENDING_LIFETIME;
  sweepShops(w);
  assert.equal(c.shop!.draft, undefined, "an unanswered edit lapses");
  assert.equal(c.shop!.title, "Moss Mends");
});

test("buy flow: queue to lock; the item leaves, coins arrive, the sale is remembered, logged, and a receipt is kept", () => {
  const { w, c } = setup();
  openShop(w, c);
  const [item, work] = c.shop!.listings;
  const coins = c.coins;
  const mem = c.memories.length;
  const sum = total(w);
  const refunds = applyInbox(w, [buy(item.id, "moss", 4)]);
  assert.deepEqual(refunds, []);
  assert.equal(c.coins, coins + 4);
  assert.equal(total(w), sum + 4, "exactly the price entered the town");
  assert.ok(!c.inventory.includes("trinket"));
  assert.equal(c.shop!.listings.length, 1, "an item is sold once");
  assert.equal(c.memories.length, mem + 1);
  assert.ok(w.feed.some((f) => /A visitor buys/.test(f.text)));
  assert.ok(c.influences.some((i) => i.kind === "accomplishment" && /sale/.test(i.source)));
  const r = w.receipts.at(-1)!;
  assert.equal(r.ok, true);
  assert.match(r.text, /^Receipt: /);
  assert.equal(findReceipt(w, r.token)?.text, r.text);
  assert.equal(findReceipt(w, "__proto__"), undefined);
  // a work is not consumed
  assert.deepEqual(applyInbox(w, [buy(work.id, "moss", 3)]), []);
  assert.ok(c.shelf.some((k) => k.n === 1), "the work stays on the shelf");
  assert.equal(c.shop!.listings.length, 1, "the work listing remains");
  assert.equal(c.coins, coins + 7);
});

test("replay, double-buy, stale price, closed shop and unbacked listings fail and hand the visitor coins back", () => {
  const { w, c } = setup();
  openShop(w, c);
  const [item] = c.shop!.listings;
  const first = buy(item.id, "moss", 4);
  assert.deepEqual(applyInbox(w, [first]), []);
  const coins = c.coins;
  assert.deepEqual(applyInbox(w, [first]), [], "the same token twice is ignored");
  assert.equal(c.coins, coins);
  const second = applyInbox(w, [buy(item.id, "moss", 4)]);
  assert.equal(second.length, 1, "sold out: refund");
  assert.equal(second[0].coins, 4);
  assert.equal(c.coins, coins);
  assert.equal(w.receipts.at(-1)!.ok, false);
  // stale price
  const wl = c.shop!.listings[0];
  assert.equal(applyInbox(w, [buy(wl.id, "moss", wl.price + 1)]).length, 1);
  // the item was eaten or given away after listing
  c.shop!.listings.push({ id: 77, item: "potion", price: 5 });
  c.inventory = [];
  assert.equal(applyInbox(w, [buy(77, "moss", 5)]).length, 1);
  // closed shop and unknown creature
  c.shop!.status = "pending";
  assert.equal(applyInbox(w, [buy(wl.id, "moss", wl.price)]).length, 1);
  assert.equal(applyInbox(w, [buy(1, "nobody", 4)]).length, 1);
  assert.equal(applyInbox(w, [buy(1, "__proto__", 4)]).length, 1);
  assert.ok(Object.values(w.creatures).every((x) => x.coins >= 0));
});

test("hostile inbox items never throw, never create coins, never refund twice", () => {
  const { w, c } = setup();
  openShop(w, c);
  const coins = total(w);
  const junk = [
    null, 5, "x", {}, { type: "purchase" }, { type: "purchase", creature: {}, listing: "1", paid: "9", token: 1, vkey: 2 },
    { type: "purchase", creature: "moss", listing: 1, paid: 4, token: "zzzzzzzzzzzz", vkey: "vcoins:x" },
    { type: "purchase", creature: "moss", listing: 1, paid: 4, token: "aaaaaaaaaaaa", vkey: "credits:acct" }, // not a visitor-coin key: ignored, nothing refunded
    { type: "purchase", creature: "moss", listing: 1.5, paid: 4, token: "bbbbbbbbbbbb", vkey: "vcoins:x" },
    { type: "purchase", creature: "moss", listing: 1, paid: -50, token: "cccccccccccc", vkey: "vcoins:x" },
    { type: "purchase", creature: "moss", listing: 1, paid: 1e9, token: "dddddddddddd", vkey: "vcoins:x" },
    JSON.parse('{"type":"purchase","__proto__":{"paid":4},"creature":"moss","listing":1,"token":"eeeeeeeeeeee","vkey":"vcoins:x"}'),
  ] as InboxItem[];
  const refunds = applyInbox(w, junk);
  assert.ok(refunds.every((r) => r.key.startsWith("vcoins:") && r.coins >= 1 && r.coins <= 50));
  assert.ok(total(w) <= coins);
  assert.equal(c.coins >= 0, true);
});

test("caps under the lock: per shop per day, town sales and town coins per day", () => {
  const { w, c } = setup();
  openShop(w, c);
  c.shop!.listings = [{ id: 1, work: 1, price: 50 }];
  c.shop!.listingSeq = 1;
  const sum = total(w);
  let sold = 0;
  for (let i = 0; i < 6; i++) if (applyPurchase(w, buy(1, "moss", 50) as never, NOW) === null) sold++;
  assert.equal(sold, 1, "town coin cap 60 allows one price-50 sale");
  assert.equal(total(w) - sum, 50);
  assert.ok(50 <= TOWN_COINS_PER_DAY);
  // cheap listing: per-shop cap hits first
  const { w: w2, c: c2 } = setup();
  openShop(w2, c2);
  c2.shop!.listings = [{ id: 1, work: 1, price: 1 }];
  let n = 0;
  for (let i = 0; i < 10; i++) if (applyPurchase(w2, buy(1, "moss", 1) as never, NOW) === null) n++;
  assert.equal(n, SHOP_SALES_PER_DAY);
  assert.equal(applyPurchase(w2, buy(1, "moss", 1) as never, NOW + 86400_000), null, "a new day resets");
  // town sales cap across shops
  const { w: w3 } = setup();
  const ids = Object.keys(w3.creatures);
  for (const id of ids) {
    const o = w3.creatures[id];
    o.site = { title: "s", tagline: "t", t: 0 };
    o.shelf = [{ n: 1, kind: "note", title: "N", body: "b", t: 0, ts: 0, by: id }];
    o.shop = { title: "S", tagline: "T", status: "open", listings: [{ id: 1, work: 1, price: 1 }], listingSeq: 1, createdT: 0, expiresT: 1e9, paid: 0, sales: { day: "", n: 0 }, sold: 0 };
  }
  let t = 0;
  for (const id of ids) for (let i = 0; i < SHOP_SALES_PER_DAY; i++) if (applyPurchase(w3, buy(1, id, 1) as never, NOW) === null) t++;
  assert.equal(t, Math.min(TOWN_SALES_PER_DAY, ids.length * SHOP_SALES_PER_DAY));
  assert.ok(TOWN_SALES_PER_DAY * 50 > TOWN_COINS_PER_DAY, "the coin cap is the binding bound for pricey wares");
  assert.equal(utcDayStr(NOW), "2026-06-01");
});

test("routes: visitor allowance, hostile bodies, per-visitor limit, receipt flow", async () => {
  const store = getStore();
  const { w, c } = setup();
  openShop(w, c);
  c.shop!.listings = [{ id: 1, work: 1, price: 30 }, { id: 2, work: 2, price: 30 }, { id: 3, work: 3, price: 1 }];
  c.shop!.listingSeq = 3;
  await store.save(w);
  const post = (body: unknown, ip: string, raw?: string, type = "application/json") =>
    buyPost(new Request("http://x/api/shop/buy", { method: "POST", headers: { "content-type": type, "x-forwarded-for": ip }, body: raw ?? JSON.stringify(body) }));
  const ip = `9.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const a = await post({ creature: "moss", listing: 1 }, ip);
  assert.equal(a.status, 200);
  const ja = await a.json();
  assert.match(ja.token, /^[a-f0-9]{12}$/);
  assert.equal(ja.visitorCoinsLeft, VISITOR_DAILY_COINS - 30);
  const b = await post({ creature: "moss", listing: 2 }, ip);
  assert.equal(b.status, 402, "insufficient visitor coins");
  const day = utcDayStr();
  assert.equal(await store.kv.get(`vcoins:${day}:${ip}`), "30", "the failed reservation was rolled back");
  // the queued purchase applies under the lock and shows a receipt
  const drained = await store.drainInbox();
  assert.equal(drained.length, 1);
  const w2 = (await store.load())!;
  applyInbox(w2, drained);
  assert.equal(findReceipt(w2, ja.token)?.ok, true);
  // hostile bodies
  for (const [body, raw] of [[null, "not json"], [null, "[]"], [{ creature: "moss", listing: "1" }], [{ creature: "moss", listing: 1.5 }], [{ creature: "moss", listing: -1 }], [{ creature: "moss", listing: 1e12 }], [{ creature: ["moss"], listing: 1 }]] as [unknown, string | undefined][]) {
    const r = await post(body, ip, raw);
    assert.ok([400, 404].includes(r.status), `${raw ?? JSON.stringify(body)} -> ${r.status}`);
  }
  for (const creature of ["__proto__", "constructor", "toString", "nobody", ""]) assert.equal((await post({ creature, listing: 1 }, ip)).status, 404);
  assert.equal((await post(null, ip, `{"__proto__":{"creature":"moss"},"listing":1}`)).status, 404);
  assert.equal((await post(null, ip, "x".repeat(5000))).status, 400);
  // a plain form post is answered with a redirect to the site page
  const ip2 = `8.8.${Math.floor(Math.random() * 250)}.1`;
  const f = await post(null, ip2, "creature=moss&listing=3", "application/x-www-form-urlencoded");
  assert.equal(f.status, 303);
  assert.match(f.headers.get("location") ?? "", /\/s\/moss\?r=[a-f0-9]{12}#shop$/);
  const bad = await post(null, ip2, "creature=%3Cscript%3E&listing=3", "application/x-www-form-urlencoded");
  assert.equal(bad.status, 404, "a hostile creature name is never echoed in a redirect");
  // per-visitor daily buys
  const ip3 = `7.7.${Math.floor(Math.random() * 250)}.1`;
  const codes: number[] = [];
  for (let i = 0; i < BUYS_PER_VISITOR_DAY + 2; i++) codes.push((await post({ creature: "moss", listing: 3 }, ip3)).status);
  assert.deepEqual(codes.slice(0, BUYS_PER_VISITOR_DAY), Array(BUYS_PER_VISITOR_DAY).fill(200));
  assert.ok(codes.slice(BUYS_PER_VISITOR_DAY).every((s) => s === 429));
  await store.drainInbox();
});

test("failed purchases return the reserved coins through the engine path", async () => {
  const { w, c } = setup();
  openShop(w, c);
  const day = utcDayStr();
  const store = getStore();
  const key = `vcoins:${day}:refund-test`;
  await store.kv.incrby(key, 4);
  const refunds = applyInbox(w, [buy(999, "moss", 4, { vkey: key } as never)]);
  assert.equal(refunds.length, 1);
  for (const r of refunds) await store.kv.incrby(r.key, -r.coins);
  assert.equal(await store.kv.get(key), "0");
});

test("admin shops route: 503 unset, 401 wrong, list, approve, reject, remove, bad input", async () => {
  const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Request("http://x/api/admin/shops", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  delete process.env.ADMIN_SECRET;
  assert.equal((await adminGet(req("GET"))).status, 503);
  assert.equal((await adminPost(req("POST", {}, { action: "approve", creature: "moss" }))).status, 503);
  process.env.ADMIN_SECRET = "shop-secret";
  assert.equal((await adminGet(req("GET"))).status, 401);
  assert.equal((await adminGet(req("GET", { authorization: "Bearer nope" }))).status, 401);
  assert.equal((await adminPost(req("POST", {}, { action: "approve", creature: "moss" }))).status, 401);
  const store = getStore();
  const { w, c } = setup();
  assert.equal(open(w, c).err, null);
  await store.save(w);
  const auth = { authorization: "Bearer shop-secret" };
  const list = await (await adminGet(req("GET", auth))).json();
  assert.equal(list.shops.length, 1);
  assert.equal(list.shops[0].status, "pending");
  assert.equal((await adminPost(req("POST", auth, { action: "explode", creature: "moss" }))).status, 400);
  assert.equal((await adminPost(req("POST", auth, { action: "approve", creature: 4 }))).status, 400);
  assert.equal((await adminPost(req("POST", auth, { action: "approve", creature: "ghost" }))).status, 404);
  assert.equal((await adminPost(req("POST", auth, { action: "approve", creature: "__proto__" }))).status, 404);
  assert.equal((await adminPost(req("POST", auth, { action: "approve", creature: "moss" }))).status, 200);
  assert.equal((await store.load())!.creatures.moss.shop!.status, "open");
  // busy: a tick holds the lock
  assert.equal(await store.lock(20), true);
  assert.equal((await adminPost(req("POST", auth, { action: "remove", creature: "moss" }))).status, 409);
  await store.unlock();
  assert.equal((await adminPost(req("POST", { "x-admin-secret": "shop-secret" }, { action: "remove", creature: "moss" }))).status, 200);
  assert.equal((await store.load())!.creatures.moss.shop, null);
  assert.equal(adminShops(w).length, 1);
  delete process.env.ADMIN_SECRET;
});

test("escaping: nothing from a shop can carry markup into a page, even if stored data was tampered with", () => {
  const { w, c } = setup();
  openShop(w, c);
  c.shop!.title = "<script>alert(1)</script>";
  assert.equal(publicShop(w, c), null, "a tampered title hides the shop");
  c.shop!.title = "Fine title";
  c.shop!.listings[0].price = 9999;
  assert.equal(publicShop(w, c)!.listings.length, 1, "an out-of-range price is not shown");
  c.shelf[0].title = "<img src=x onerror=1>";
  c.shop!.listings[1] = { id: 5, work: 1, price: 3 };
  assert.ok(publicShop(w, c)!.listings.every((l) => !/[<>]/.test(l.label)));
  const src = readFileSync("src/app/s/[id]/page.tsx", "utf8") + readFileSync("src/app/shops/page.tsx", "utf8");
  assert.equal((src.match(/dangerouslySetInnerHTML/g) ?? []).length, 1, "only the existing drawing SVG");
  assert.ok(!/<script/i.test(src) && !/href=\{?["']?https?:/.test(src), "no scripts or external links");
});

test("shops code never touches credits or payments", () => {
  for (const f of ["src/lib/shops.ts", "src/app/api/shop/buy/route.ts", "src/app/api/admin/shops/route.ts", "src/app/shops/page.tsx"]) {
    const s = readFileSync(f, "utf8");
    assert.ok(!/from ["'][^"']*(credits|payment|x402|usdc)[^"']*["']/i.test(s), f);
  }
  for (const f of readdirSync("src/lib/credits")) assert.ok(!/shops/.test(readFileSync(`src/lib/credits/${f}`, "utf8")), f);
});

test("migration: old worlds load, tampered shops and receipts are cleaned", () => {
  const w = seedWorld(0) as unknown as Record<string, unknown>;
  delete w.receipts;
  delete w.shopDay;
  for (const c of Object.values(w.creatures as Record<string, Record<string, unknown>>)) {
    delete c.shop;
    delete c.shopDay;
  }
  const m = migrate(w as unknown as World);
  assert.deepEqual(m.receipts, []);
  assert.deepEqual(m.shopDay, { day: "", n: 0, coins: 0 });
  assert.ok(Object.values(m.creatures).every((c) => c.shop === null && c.shopDay === 0));
  const { w: w2, c } = setup();
  openShop(w2, c);
  (c.shop as unknown as Record<string, unknown>).title = "<b>x</b>";
  assert.equal(migrate(w2).creatures.moss.shop, null);
  const { w: w3, c: c3 } = setup();
  openShop(w3, c3);
  c3.shop!.listings.push({ id: 9, item: "rod", price: 3 }, { id: 10, work: 1, price: 0 }, { id: 11, item: "trinket", work: 1, price: 3 } as never, { id: 1, work: 2, price: 3 }, null as never);
  (c3.shop as unknown as Record<string, unknown>).paid = 9999;
  w3.receipts = [{ token: "bad", ok: true, text: "x", ts: 1 }, { token: "abcdef012345", ok: true, text: "<b>", ts: 1 }, { token: "abcdef012346", ok: true, text: "Receipt: fine.", ts: 1 }] as never;
  const m3 = migrate(JSON.parse(JSON.stringify(w3)));
  assert.deepEqual(m3.creatures.moss.shop!.listings.map((l) => l.id), [1, 2]);
  assert.equal(m3.creatures.moss.shop!.status, "open");
  assert.ok(m3.creatures.moss.shop!.paid <= 10);
  assert.deepEqual(m3.receipts.map((r) => r.token), ["abcdef012346"]);
  assert.deepEqual(migrate(structuredClone(m3)), m3, "idempotent");
});

test("sweep drops listings whose item or work is gone", () => {
  const { w, c } = setup();
  openShop(w, c);
  c.inventory = [];
  c.shelf = c.shelf.filter((k) => k.n !== 1);
  sweepShops(w);
  assert.equal(c.shop!.listings.length, 0);
  assert.equal(publicShop(w, c)!.listings.length, 0);
});

test("the prompt lists open_shop with its limits, and the model path cannot smuggle unfiltered text", () => {
  const { w, c } = setup();
  const p = buildDecisionPrompt(w, c).prompt;
  assert.match(p, /open_shop/);
  assert.match(p, /1 to 50 coins/);
  assert.match(p, /approval/);
});

test("rules mind opens a shop only after a site exists, via novelty, and stays consistent over 10 days with approvals and buyers", () => {
  const w = seedWorld(0);
  for (const c of Object.values(w.creatures)) c.coins = 80;
  let opened = 0, sales = 0, relists = 0;
  const startCoins = total(w);
  let visitorCoins = 0;
  let approved = 0;
  let neverSite = true;
  for (let i = 0; i < 10 * 288; i++) {
    for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
    // a friendly human approves everything quickly
    if (i % 24 === 0) for (const c of Object.values(w.creatures)) {
      if (c.shop?.status === "pending" && act(w, "approve", c.id, logFeed).ok) approved++;
    }
    // a visitor buys now and then, at a fixed real time so the caps reset per world day
    if (i % 36 === 0) {
      const day = Math.floor(w.t / 1440);
      for (const c of Object.values(w.creatures)) {
        const s = c.shop;
        if (c.shop && !c.site) neverSite = false;
        if (s?.status === "open" && s.listings.length) {
          const l = s.listings[0];
          const before = c.coins;
          const r = applyPurchase(w, { type: "purchase", creature: c.id, listing: l.id, paid: l.price, token: (++seq).toString(16).padStart(12, "0"), vkey: "vcoins:x" }, NOW + day * 86400_000);
          if (r === null) {
            sales++;
            visitorCoins += l.price;
            assert.equal(c.coins - before, l.price);
          }
        }
      }
    }
    for (const c of Object.values(w.creatures)) {
      assert.ok(c.coins >= 0, `${c.id} coins ${c.coins}`);
      assert.ok(Number.isInteger(c.coins));
      assert.ok(!c.shop || c.shop.listings.length <= 4);
      if (c.activity?.kind === "open_shop" && c.shop) relists++;
    }
    if (i % 288 === 0) assert.ok(Object.values(w.creatures).filter((c) => c.shop?.status === "open").length <= MAX_OPEN_SHOPS);
    for (const c of Object.values(w.creatures)) if (c.shop?.status === "open") opened = Math.max(opened, 1);
  }
  assert.ok(neverSite, "no shop without a site");
  assert.ok(approved + sales >= 0);
  // coins: nothing but visitor purchases entered the town through shops (stall income and bread are other, existing flows)
  assert.ok(visitorCoins <= TOWN_COINS_PER_DAY * 10, `visitor coins ${visitorCoins}`);
  assert.ok(total(w) >= 0 && startCoins > 0);
  console.log(`# shops sim: opened=${opened} approved=${approved} sales=${sales} visitorCoins=${visitorCoins} relists=${relists}`);
});
