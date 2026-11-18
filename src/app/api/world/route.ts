import { NextResponse, after } from "next/server";
import { advanceWorld, loadWorld } from "@/lib/engine";
import { publicView } from "@/lib/view";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Public, keyless read API. A read also nudges the world forward if it is due,
// so the town is alive whenever someone is watching.
export async function GET() {
  const { world, storage } = await loadWorld();
  after(async () => {
    try {
      await advanceWorld();
    } catch (e) {
      console.error("tick failed", e);
    }
  });
  return NextResponse.json(publicView(world, storage), { headers: { "Cache-Control": "no-store" } });
}
