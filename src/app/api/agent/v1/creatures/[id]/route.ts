import { loadWorld } from "@/lib/engine";
import { agentIp, creatureDoc, readAllowed, reply, tooMany } from "@/lib/agent";
import { own } from "@/lib/own";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await readAllowed(agentIp(req)))) return tooMany();
  const { id } = await ctx.params;
  const { world } = await loadWorld();
  const c = own(world.creatures, id);
  if (!c) return reply({ error: "not found" }, 404);
  return reply(creatureDoc(world, c), 200, true);
}
