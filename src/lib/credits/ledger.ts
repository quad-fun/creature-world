// Closed-loop credits ledger. Integer cents (USD). Append-only entries, no negative balances,
// no withdrawals, no transfers between accounts. Creatures never touch this (see test/credits.test.ts).
import { randomUUID } from "node:crypto";
import type { Kv } from "../store";

export type EntryKind = "topup" | "allowance" | "spend";

export interface Entry {
  id: string;
  ts: number;
  account: string;
  /** Positive for credits in, negative for spends. Integer cents. */
  delta: number;
  kind: EntryKind;
  /** Short label: provider ref for top-ups, sink name for spends. */
  ref: string;
  balanceAfter: number;
}

export class InsufficientFunds extends Error {
  constructor() {
    super("insufficient credits");
  }
}

export const MAX_BALANCE_CENTS = 10_000;
const balKey = (a: string) => `cr:bal:${a}`;
const logKey = (a: string) => `cr:log:${a}`;
const idemKey = (a: string, k: string) => `cr:idem:${a}:${k}`;

export async function balance(kv: Kv, account: string): Promise<number> {
  return Number((await kv.get(balKey(account))) ?? 0);
}

export async function recent(kv: Kv, account: string, n = 20): Promise<Entry[]> {
  return (await kv.lrange(logKey(account), -n, -1)).map((x) => JSON.parse(x) as Entry).reverse();
}

export interface ApplyResult {
  entry: Entry;
  /** True when the idempotency key had been used before; nothing new was written. */
  replayed: boolean;
}

/**
 * Append one entry. `delta` must be a non-zero integer. With an idempotency key, repeating the call returns the
 * original entry and changes nothing. Debits that would take the balance below zero throw InsufficientFunds.
 */
export async function apply(kv: Kv, account: string, delta: number, kind: EntryKind, ref: string, idem?: string): Promise<ApplyResult> {
  if (!Number.isSafeInteger(delta) || delta === 0) throw new Error("amount must be a non-zero integer number of cents");
  if ((kind === "spend") !== (delta < 0)) throw new Error("spends are negative, everything else positive");
  const ik = idem ? idemKey(account, idem) : null;
  if (ik && !(await kv.setnx(ik, "pending"))) {
    const prior = await kv.get(ik);
    if (prior && prior !== "pending") return { entry: JSON.parse(prior) as Entry, replayed: true };
    throw new Error("a request with this idempotency key is still in progress");
  }
  try {
    const after = await kv.incrby(balKey(account), delta);
    if (after < 0 || after > MAX_BALANCE_CENTS) {
      await kv.incrby(balKey(account), -delta); // roll back
      if (after < 0) throw new InsufficientFunds();
      throw new Error("balance cap reached");
    }
    const entry: Entry = { id: randomUUID(), ts: Date.now(), account, delta, kind, ref, balanceAfter: after };
    await kv.rpush(logKey(account), JSON.stringify(entry));
    if (ik) await kv.set(ik, JSON.stringify(entry));
    return { entry, replayed: false };
  } catch (e) {
    if (ik) await kv.del(ik); // failed attempts may be retried
    throw e;
  }
}
