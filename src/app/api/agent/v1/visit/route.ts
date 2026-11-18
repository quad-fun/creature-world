import { after } from "next/server";
import { loadWorld } from "@/lib/engine";
import { tickSoon } from "@/lib/http";
import { agentIp, readAgentJson, reply, submitVisit } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // after() runs a tick

// An AI visitor leaves a note or a postcard. Same inbox, filter and limits as /api/visit, plus stricter agent limits.
export async function POST(req: Request) {
  const body = await readAgentJson(req);
  const { world } = await loadWorld();
  const r = await submitVisit(world, agentIp(req), body, req.headers.get("x-agent-name"));
  if (r.status === 200) {
    try {
      after(tickSoon);
    } catch {
      // no request scope (tests): the next tick applies it
    }
  }
  return reply(r.json, r.status);
}
