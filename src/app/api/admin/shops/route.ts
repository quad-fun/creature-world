import { NextResponse } from "next/server";
import { checkAdmin } from "@/lib/admin";
import { adminShopAct, adminShops } from "@/lib/shops";
import { logFeed } from "@/lib/sim";
import { clientIp, readJson } from "@/lib/http";
import { getStore } from "@/lib/store";
import { seedWorld } from "@/lib/content";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function gate(req: Request) {
  const a = checkAdmin(req);
  if (!a.ok) return NextResponse.json({ error: a.status === 503 ? "admin is not configured" : "unauthorized" }, { status: a.status, headers });
  if (!(await getStore().hit(`admin:${clientIp(req)}`, 60, 60))) return NextResponse.json({ error: "slow down" }, { status: 429, headers });
  return null;
}

// GET: pending and open shops. Needs ADMIN_SECRET (Authorization: Bearer ...).
export async function GET(req: Request) {
  const denied = await gate(req);
  if (denied) return denied;
  const w = await getStore().load();
  return NextResponse.json({ shops: w ? adminShops(w) : [] }, { headers });
}

// POST {action: "approve" | "reject" | "remove", creature: "<id>"}. Runs under the world lock so it cannot race a tick.
export async function POST(req: Request) {
  const denied = await gate(req);
  if (denied) return denied;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400, headers });
  const store = getStore();
  if (!(await store.lock(20))) return NextResponse.json({ error: "world is busy, retry" }, { status: 409, headers });
  try {
    const w = (await store.load()) ?? seedWorld(Date.now());
    const r = adminShopAct(w, body.action, body.creature, logFeed);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status, headers });
    await store.save(w);
    return NextResponse.json({ ok: true, message: r.message, shops: adminShops(w) }, { headers });
  } finally {
    await store.unlock();
  }
}
