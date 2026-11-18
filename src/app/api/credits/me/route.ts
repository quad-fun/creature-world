import { balance, recent } from "@/lib/credits/ledger";
import { withAccount } from "@/lib/credits/http";
import { getProvider } from "@/lib/credits/provider";
import { ALLOWANCE_CENTS, SINKS } from "@/lib/credits/sinks";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = withAccount(req);
  if ("error" in a) return a.error;
  const kv = getStore().kv;
  const p = getProvider();
  return a.json({
    account: a.id,
    balanceCents: await balance(kv, a.id),
    ledger: await recent(kv, a.id, 20),
    provider: p.name,
    testMode: p.isTest,
    allowanceCents: ALLOWANCE_CENTS,
    sinks: SINKS,
  });
}
