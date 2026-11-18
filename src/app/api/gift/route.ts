import { NextResponse, after } from "next/server";
import { loadWorld } from "@/lib/engine";
import { clientIp, readJson, tickSoon } from "@/lib/http";
import { checkText, visitorMessage } from "@/lib/filter";
import { sanitizeName, sanitizeText } from "@/lib/inbox";
import { DESC_MAX, NAME_MAX, normName } from "@/lib/items";
import { getStore } from "@/lib/store";
import { own } from "@/lib/own";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // after() runs a tick

// Visitors can give any small thing as free text: a name and a short description. 2 a day each, 10 a day town-wide.
// Both fields pass the English-only filter here and again when applied. The description is only ever read by the
// appraiser; creatures see the appraised version.
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const to = typeof body.to === "string" ? body.to : "";
  const from = sanitizeName(body.from) || "a visitor";
  const name = sanitizeName(body.name, NAME_MAX);
  const description = sanitizeText(body.description, DESC_MAX);
  if (name.length < 2 || !normName(name)) return NextResponse.json({ error: "what is the gift called?" }, { status: 400 });

  const store = getStore();
  const ip = clientIp(req);
  for (const field of [name, description, from === "a visitor" ? "" : from]) {
    const v = checkText(field, { allowEmpty: true });
    if (!v.ok) {
      if (!(await store.hit(`bad:${ip}`, 10, 86400))) return NextResponse.json({ error: "too many tries today; come back tomorrow" }, { status: 429 });
      return NextResponse.json({ error: visitorMessage(v.reason) }, { status: 422 });
    }
  }

  const { world } = await loadWorld();
  if (!own(world.creatures, to)) return NextResponse.json({ error: "no such creature" }, { status: 404 });

  const ok = (await store.hit(`gift:${ip}`, 2, 86400)) && (await store.hit("gift:all", 10, 86400));
  if (!ok) return NextResponse.json({ error: "slow down a little; try again later" }, { status: 429 });

  await store.pushInbox({ type: "gift", to, from, name, description });
  after(tickSoon);
  return NextResponse.json({ ok: true, message: "Delivered. They will look it over shortly." });
}
