import { apply } from "@/lib/credits/ledger";
import { withAccount } from "@/lib/credits/http";
import { getProvider } from "@/lib/credits/provider";
import { readJson } from "@/lib/http";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
const AMOUNTS = [100, 500, 1000, 2500];

// TEST top-up. With the fake provider this just credits the account; real providers throw "not configured".
export async function POST(req: Request) {
  const a = withAccount(req);
  if ("error" in a) return a.error;
  const body = (await readJson(req)) ?? {};
  const cents = Number(body.cents ?? 500);
  if (!AMOUNTS.includes(cents)) return a.json({ error: `amount must be one of ${AMOUNTS.join(", ")} cents` }, 400);
  const store = getStore();
  if (!(await store.hit(`credits:topup:${a.id}`, 10, 86400))) return a.json({ error: "top-up limit reached for today" }, 429);
  try {
    const p = getProvider();
    const t = await p.createTopUp(a.id, cents);
    const idem = typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 64) : undefined;
    const r = await apply(store.kv, a.id, cents, "topup", `${p.isTest ? "TEST " : ""}${p.name} ${t.ref}`, idem && `topup:${idem}`);
    return a.json({ ok: true, test: p.isTest, entry: r.entry, replayed: r.replayed });
  } catch (e) {
    return a.json({ error: (e as Error).message }, /not configured/.test((e as Error).message) ? 501 : 400);
  }
}
