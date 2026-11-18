import { NextResponse, after } from "next/server";
import { loadWorld } from "@/lib/engine";
import { clientIp, readJson, tickSoon } from "@/lib/http";
import { checkText, visitorMessage } from "@/lib/filter";
import { sanitizeName, sanitizeText } from "@/lib/inbox";
import { getProvider } from "@/lib/credits/provider";
import { paymentRequired } from "@/lib/credits/x402";
import { getStore } from "@/lib/store";
import { own } from "@/lib/own";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// x402-style paid note (STUB). No header: 402 with payment requirements. Fake provider only: a fake test header is
// accepted and the note goes through the same filter, rate limits and inbox as /api/visit. Any other provider: header refused.
export async function POST(req: Request) {
  const header = req.headers.get("x-payment");
  if (!header) return NextResponse.json(paymentRequired(new URL(req.url).pathname), { status: 402 });

  const provider = getProvider();
  if (!provider.isTest) return NextResponse.json({ error: "payment verification is not implemented; payment headers are refused" }, { status: 501 });
  const pay = await provider.verifyPaymentHeader(header);
  if (!pay.ok || !pay.nonce) return NextResponse.json({ ...paymentRequired(new URL(req.url).pathname), error: "invalid test payment" }, { status: 402 });

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const to = typeof body.to === "string" ? body.to : "";
  const from = sanitizeName(body.from) || "a visitor";
  const text = sanitizeText(body.text, 200);
  if (text.length < 2) return NextResponse.json({ error: "write a few words" }, { status: 400 });
  const store = getStore();
  const ip = clientIp(req);
  for (const field of [text, from === "a visitor" ? "" : from]) {
    const v = checkText(field, { allowEmpty: field !== text });
    if (!v.ok) {
      if (!(await store.hit(`bad:${ip}`, 10, 86400))) return NextResponse.json({ error: "too many tries today; come back tomorrow" }, { status: 429 });
      return NextResponse.json({ error: visitorMessage(v.reason) }, { status: 422 });
    }
  }
  const { world } = await loadWorld();
  if (!own(world.creatures, to)) return NextResponse.json({ error: "no such creature" }, { status: 404 });
  if (!((await store.hit(`note:${ip}`, 6, 3600)) && (await store.hit("note:all", 80, 86400))))
    return NextResponse.json({ error: "slow down a little; try again later" }, { status: 429 });
  if (!(await store.kv.setnx(`x402:nonce:${pay.nonce}`, "1"))) return NextResponse.json({ error: "payment already used" }, { status: 402 });

  await store.pushInbox({ type: "note", to, from, text });
  try {
    after(tickSoon);
  } catch {
    // outside a request scope (unit tests): the cron tick will pick it up
  }
  const settle = Buffer.from(JSON.stringify({ success: true, test: true, network: "base-sepolia", note: "fake settlement" })).toString("base64");
  return NextResponse.json({ ok: true, test: true, message: "Delivered (TEST payment)." }, { headers: { "x-payment-response": settle } });
}
