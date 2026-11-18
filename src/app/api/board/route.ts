import { NextResponse } from "next/server";
import { loadWorld } from "@/lib/engine";

export const dynamic = "force-dynamic";

// The public notice board: what creatures post for the outside world, and what visitors leave.
export async function GET() {
  const { world } = await loadWorld();
  return NextResponse.json({ board: [...world.board].reverse().slice(0, 40) }, { headers: { "Cache-Control": "no-store" } });
}
