import { NextResponse, after } from "next/server";
import { randomBytes } from "node:crypto";
import { loadWorld } from "@/lib/engine";
import { clientIp, readJson, tickSoon } from "@/lib/http";
import { getStore } from "@/lib/store";
import { own } from "@/lib/own";
import { BUYS_PER_VISITOR_DAY, SHOP_SALES_PER_DAY, TOWN_COINS_PER_DAY, TOWN_SALES_PER_DAY, VISITOR_DAILY_COINS, backed, utcDayStr } from "@/lib/shops";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // after() runs a tick

// Buy one listing with in-world "visitor coins" (closed loop: a small daily allowance per IP, no real money, nothing to do
// with credits). The route only reserves coins and queues the purchase; the world applies it under its lock and applies
// every cap again. Accepts JSON or a plain HTML form post (the site page has no scripts). A form post is answered with a
// redirect back to the site page, where the receipt shows.
const MSG: Record<string, string> = {
  coins: "Not enough visitor coins left today.",
  slow: "Slow down a little; try again later.",
  closed: "That shop is not open.",
  gone: "That listing is gone.",
  busy: "The shop has sold enough for today.",
};

async function parse(req: Request): Promise<{ body: Record<string, unknown> | null; form: boolean }> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      if (Number(req.headers.get("content-length") ?? 0) > 2000) return { body: null, form: true };
      const text = await req.text();
      if (text.length > 1000) return { body: null, form: true };
      const p = new URLSearchParams(text);
      return { body: { creature: p.get("creature") ?? "", listing: Number(p.get("listing")) }, form: true };
    } catch {
      return { body: null, form: true };
    }
  }
  return { body: await readJson(req), form: false };
}

export async function POST(req: Request) {
  const { body, form } = await parse(req);
  const back = (creature: string, qs: string, status: number, json: Record<string, unknown>) =>
    form && /^[a-z0-9-]{1,30}$/.test(creature) ? NextResponse.redirect(new URL(`/s/${creature}?${qs}#shop`, req.url), 303) : NextResponse.json(json, { status });
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const creature = typeof body.creature === "string" ? body.creature : "";
  const listing = body.listing;
  if (typeof listing !== "number" || !Number.isInteger(listing) || listing < 1 || listing > 1e9) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const fail = (code: keyof typeof MSG, status: number) => back(creature, `e=${code}`, status, { error: MSG[code] });

  const { world } = await loadWorld();
  const c = own(world.creatures, creature);
  const s = c?.shop;
  if (!c || !s || s.status !== "open" || !c.site) return fail("closed", 404);
  const l = s.listings.find((x) => x.id === listing);
  if (!l || !backed(c, l)) return fail("gone", 404);

  const store = getStore();
  const ip = clientIp(req);
  const day = utcDayStr();
  // early, cheap pre-checks (the lock-side checks in applyPurchase are the authority)
  if (world.shopDay?.day === day && (world.shopDay.n >= TOWN_SALES_PER_DAY || world.shopDay.coins + l.price > TOWN_COINS_PER_DAY)) return fail("busy", 409);
  if (s.sales.day === day && s.sales.n >= SHOP_SALES_PER_DAY) return fail("busy", 409);
  if (!(await store.hit(`shopbuy:${ip}`, 12, 3600)) || !(await store.hit(`shopbuyday:${ip}`, BUYS_PER_VISITOR_DAY, 86400)) || !(await store.hit(`shopsales:${creature}:${day}`, SHOP_SALES_PER_DAY * 3, 86400)) || !(await store.hit(`shopall:${day}`, TOWN_SALES_PER_DAY * 4, 86400))) {
    return fail("slow", 429);
  }
  // reserve from this visitor's daily allowance (closed loop; kv keys are separate from the credits ledger)
  const vkey = `vcoins:${day}:${ip.slice(0, 64).replace(/[^A-Za-z0-9:.]/g, "_")}`;
  const total = await store.kv.incrby(vkey, l.price);
  if (total > VISITOR_DAILY_COINS) {
    await store.kv.incrby(vkey, -l.price);
    return fail("coins", 402);
  }
  const token = randomBytes(6).toString("hex");
  await store.pushInbox({ type: "purchase", creature, listing, paid: l.price, token, vkey });
  try {
    after(tickSoon);
  } catch {
    // no request scope (tests, scripts): the next tick applies the purchase
  }
  const left = VISITOR_DAILY_COINS - total;
  return form
    ? NextResponse.redirect(new URL(`/s/${creature}?r=${token}#shop`, req.url), 303)
    : NextResponse.json({ ok: true, token, paid: l.price, visitorCoinsLeft: left, message: "Queued. Your receipt will appear on the site page shortly." });
}
