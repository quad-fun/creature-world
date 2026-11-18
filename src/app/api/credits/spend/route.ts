import { InsufficientFunds } from "@/lib/credits/ledger";
import { withAccount } from "@/lib/credits/http";
import { isSink, spend } from "@/lib/credits/sinks";
import { readJson } from "@/lib/http";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

// Buy an entitlement ticket. Nothing in the world changes here; flows like /api/adopt redeem the ticket.
export async function POST(req: Request) {
  const a = withAccount(req);
  if ("error" in a) return a.error;
  const body = (await readJson(req)) ?? {};
  if (!isSink(body.sink)) return a.json({ error: "unknown sink" }, 400);
  const store = getStore();
  if (!(await store.hit(`credits:spend:${a.id}`, 30, 3600))) return a.json({ error: "slow down" }, 429);
  const idem = typeof body.idempotencyKey === "string" ? `spend:${body.idempotencyKey.slice(0, 64)}` : undefined;
  try {
    const r = await spend(store.kv, a.id, body.sink, body.params, idem);
    return a.json({ ok: true, ticket: r.ticket, replayed: r.replayed });
  } catch (e) {
    if (e instanceof InsufficientFunds) return a.json({ error: "not enough credits" }, 402);
    return a.json({ error: (e as Error).message }, 400);
  }
}
