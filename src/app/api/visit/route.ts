import { NextResponse, after } from "next/server";
import { loadWorld } from "@/lib/engine";
import { clientIp, readJson, tickSoon } from "@/lib/http";
import { checkText, visitorMessage } from "@/lib/filter";
import { sanitizeName, sanitizeText } from "@/lib/inbox";
import { getStore } from "@/lib/store";
import { own } from "@/lib/own";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // after() runs a tick

// Visitors can leave a note (at most 6 an hour each, 80 a day town-wide) or a loaf of bread
// (1 a day each, 12 a day town-wide). Everything is sanitised and reaches creatures only as speech.
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const kind = body.kind === "treat" ? "treat" : body.kind === "note" ? "note" : null;
  const to = typeof body.to === "string" ? body.to : "";
  const from = sanitizeName(body.from) || "a visitor";
  const text = sanitizeText(body.text, 200);
  if (!kind) return NextResponse.json({ error: "kind must be note or treat" }, { status: 400 });
  if (kind === "note" && text.length < 2) return NextResponse.json({ error: "write a few words" }, { status: 400 });

  const store0 = getStore();
  if (kind === "note") {
    const v = checkText(text);
    if (!v.ok) {
      if (!(await store0.hit(`bad:${clientIp(req)}`, 10, 86400))) return NextResponse.json({ error: "too many tries today; come back tomorrow" }, { status: 429 });
      return NextResponse.json({ error: visitorMessage(v.reason) }, { status: 422 });
    }
    const nv = checkText(from === "a visitor" ? "" : from, { allowEmpty: true });
    if (!nv.ok) return NextResponse.json({ error: visitorMessage(nv.reason) }, { status: 422 });
  }

  const { world } = await loadWorld();
  if (!own(world.creatures, to)) return NextResponse.json({ error: "no such creature" }, { status: 404 });

  const store = getStore();
  const ip = clientIp(req);
  const ok =
    kind === "note"
      ? (await store.hit(`note:${ip}`, 6, 3600)) && (await store.hit("note:all", 80, 86400))
      : (await store.hit(`treat:${ip}`, 1, 86400)) && (await store.hit("treat:all", 12, 86400));
  if (!ok) return NextResponse.json({ error: "slow down a little; try again later" }, { status: 429 });

  await store.pushInbox(kind === "note" ? { type: "note", to, from, text } : { type: "treat", to, from });
  after(tickSoon);
  return NextResponse.json({ ok: true, message: "Delivered. It will show up in the town shortly." });
}
