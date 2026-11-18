import { loadWorld } from "@/lib/engine";
import { own } from "@/lib/own";
import { atomFeed } from "@/lib/library";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { world } = await loadWorld();
  const c = own(world.creatures, id);
  if (!c) return new Response("not found", { status: 404 });
  return new Response(atomFeed(world, c, new URL(req.url).origin), {
    headers: { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}
