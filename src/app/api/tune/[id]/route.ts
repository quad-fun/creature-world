import { NextResponse } from "next/server";
import { loadWorld } from "@/lib/engine";
import { findCreation, publicCreation } from "@/lib/creations";

export const dynamic = "force-dynamic";

// The pattern of a live tune as plain JSON (whitelisted values only), so anyone can keep or replay it.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { world } = await loadWorld();
  const x = findCreation(world, id, "tune");
  const p = x && publicCreation(world, x);
  if (!p) return NextResponse.json({ error: "no such tune" }, { status: 404 });
  return new NextResponse(JSON.stringify({ title: p.title, by: p.byName, tempo: p.tempo, instrument: p.instrument, steps: p.steps }, null, 1), {
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="tune-${p.id}.json"`, "Cache-Control": "no-store" },
  });
}
