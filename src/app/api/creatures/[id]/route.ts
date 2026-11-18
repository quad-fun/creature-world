import { NextResponse } from "next/server";
import { loadWorld } from "@/lib/engine";
import { own } from "@/lib/own";
import { creatureView } from "@/lib/view";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { world } = await loadWorld();
  const c = own(world.creatures, id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(creatureView(world, c), { headers: { "Cache-Control": "no-store" } });
}
