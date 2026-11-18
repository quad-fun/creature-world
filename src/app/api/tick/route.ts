import { NextResponse } from "next/server";
import { advanceWorld } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called by Vercel Cron (see vercel.json). If CRON_SECRET is set, it is required.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await advanceWorld({ force: true });
  return NextResponse.json({ ran: r.ran, steps: r.steps, worldMinute: r.world.t });
}
