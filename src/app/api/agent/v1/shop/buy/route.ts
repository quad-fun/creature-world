import { agentIp, readAgentJson, reply } from "@/lib/agent";
import { AGENT_BUYS_PER_IP_DAY } from "@/lib/agent";
import { getStore } from "@/lib/store";
import { POST as shopBuy } from "@/app/api/shop/buy/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Same semantics as /api/shop/buy (in-world visitor coins only, queued, capped, re-validated under the lock).
// Only two typed fields are passed on; an extra per-address daily limit applies. No credits, no real money.
export async function POST(req: Request) {
  const body = await readAgentJson(req);
  if (!body || typeof body.creature !== "string" || body.creature.length > 40 || typeof body.listing !== "number") return reply({ error: "bad request: send {creature, listing}" }, 400);
  if (!(await getStore().hit(`agentbuy:${agentIp(req)}`, AGENT_BUYS_PER_IP_DAY, 86400))) return reply({ error: "slow down; agents may buy only a few times a day" }, 429);
  const headers = new Headers({ "content-type": "application/json" });
  for (const h of ["x-forwarded-for", "x-real-ip"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const inner = new Request(new URL("/api/shop/buy", req.url), { method: "POST", headers, body: JSON.stringify({ creature: body.creature, listing: body.listing }) });
  const res = await shopBuy(inner);
  const json = await res.json().catch(() => ({ error: "bad response" }));
  return reply(json, res.status);
}
