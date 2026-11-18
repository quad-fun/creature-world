import { NextResponse } from "next/server";
import { advanceWorld } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called by Vercel Cron (see vercel.json). If CRON_SECRET is set, it is required and the tick is forced.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // `force` skips the minimum tick interval, so only a caller that proved the secret may use it. With no secret
  // configured this is just a normal (rate-gated) tick that anyone could trigger by visiting the site anyway.
  const r = await advanceWorld({ force: Boolean(secret) });
  return NextResponse.json({ ran: r.ran, steps: r.steps, worldMinute: r.world.t });
}
