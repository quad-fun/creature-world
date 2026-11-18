import { NextResponse, after } from "next/server";
import { randomBytes } from "node:crypto";
import { loadWorld } from "@/lib/engine";
import { clientIp, readJson, tickSoon } from "@/lib/http";
import { getStore } from "@/lib/store";
import { PLAYS_PER_CREATION_DAY, PLAYS_PER_IP_DAY, findCreation } from "@/lib/creations";
import { utcDayStr } from "@/lib/shops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// "I listened": a visitor tells a creature they heard its tune. A plain form post (no script needed). Rate limited,
// queued, applied under the world lock with its own caps. No accounts, no coins.
export async function POST(req: Request) {
  let id: unknown;
  let form = false;
  if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    form = true;
    try {
      const text = await req.text();
      id = text.length <= 500 ? Number(new URLSearchParams(text).get("tune")) : NaN;
    } catch {
      id = NaN;
    }
  } else id = (await readJson(req))?.tune;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 1e9) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { world } = await loadWorld();
  const x = findCreation(world, id, "tune");
  if (!x) return NextResponse.json({ error: "no such tune" }, { status: 404 });
  const store = getStore();
  const ip = clientIp(req);
  const day = utcDayStr();
  const counted =
    (await store.hit(`listen2:${ip}:${x.id}`, 1, 20)) &&
    (await store.hit(`gplay:${ip}:${day}`, PLAYS_PER_IP_DAY, 86400)) &&
    (await store.hit(`gplayg:${x.id}:${day}`, PLAYS_PER_CREATION_DAY * 3, 86400));
  if (counted) {
    await store.pushInbox({ type: "creation_play", id: x.id, token: randomBytes(6).toString("hex") });
    try {
      after(tickSoon);
    } catch {
      // no request scope: the next tick applies it
    }
  }
  if (form && /^[a-z0-9-]{1,30}$/.test(x.by)) return NextResponse.redirect(new URL(`/s/${x.by}?heard=${counted ? 1 : 0}#tunes`, req.url), 303);
  return NextResponse.json({ ok: true, counted }, { status: counted ? 200 : 429 });
}
