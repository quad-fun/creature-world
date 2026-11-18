import { loadWorld } from "@/lib/engine";
import { postcardFeed } from "@/lib/postcards";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { world } = await loadWorld();
  return new Response(postcardFeed(world, new URL(req.url).origin), {
    headers: { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}
