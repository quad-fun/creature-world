import { agentDescription } from "@/lib/agent-doc";
import { agentIp, readAllowed, reply, tooMany } from "@/lib/agent";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await readAllowed(agentIp(req)))) return tooMany();
  return reply(agentDescription(), 200, true);
}
