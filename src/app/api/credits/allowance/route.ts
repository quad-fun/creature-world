import { withAccount } from "@/lib/credits/http";
import { claimAllowance } from "@/lib/credits/sinks";
import { clientIp } from "@/lib/http";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const a = withAccount(req);
  if ("error" in a) return a.error;
  try {
    // A fresh cookie is a fresh account, so cap free allowances per network address as well.
    if (!(await getStore().hit(`credits:allow:ip:${clientIp(req)}`, 3, 86400))) return a.json({ ok: false, error: "too many allowances from this network today" }, 429);
    const entry = await claimAllowance(getStore(), a.id);
    return a.json(entry ? { ok: true, entry } : { ok: false, error: "already claimed today" }, entry ? 200 : 429);
  } catch (e) {
    return a.json({ error: (e as Error).message }, 400);
  }
}
