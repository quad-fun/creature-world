import { loadWorld } from "@/lib/engine";
import { agentIp, readAllowed, reply, tooMany, townDoc } from "@/lib/agent";

export const dynamic = "force-dynamic";

// Read-only. Does not advance the world and never causes a model call.
export async function GET(req: Request) {
  if (!(await readAllowed(agentIp(req)))) return tooMany();
  const { world } = await loadWorld();
  return reply(townDoc(world), 200, true);
}
