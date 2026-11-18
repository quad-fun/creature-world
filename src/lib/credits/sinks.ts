// Spend sinks, tickets (entitlements) and the free daily allowance. Spending returns a ticket record;
// it never touches world internals. Other flows (e.g. /api/adopt) redeem tickets.
import { randomBytes } from "node:crypto";
import type { Kv, Store } from "../store";
import { apply, type ApplyResult } from "./ledger";

export const SINKS = {
  launch_creature: { cents: 500, label: "Launch a creature (adoption ticket)" },
  launch_site: { cents: 300, label: "Launch a creature website" },
  extra_shelf_slot: { cents: 100, label: "One extra library shelf slot" },
  extra_daily_calls: { cents: 200, label: "Extra daily thinking calls for one creature" },
} as const;
export type SinkName = keyof typeof SINKS;
export const isSink = (s: unknown): s is SinkName => typeof s === "string" && Object.prototype.hasOwnProperty.call(SINKS, s);

export const ALLOWANCE_CENTS = 25;

export interface Ticket {
  id: string;
  account: string;
  sink: SinkName;
  params: Record<string, string | number>;
  cents: number;
  ts: number;
  status: "unused" | "redeemed";
}

const ticketKey = (id: string) => `cr:ticket:${id}`;

function cleanParams(p: unknown): Ticket["params"] {
  const out: Ticket["params"] = {};
  if (p && typeof p === "object") {
    for (const [k, v] of Object.entries(p as Record<string, unknown>).slice(0, 5)) {
      if (/^[a-z_]{1,24}$/.test(k) && (typeof v === "number" || typeof v === "string")) out[k] = typeof v === "string" ? v.slice(0, 40) : v;
    }
  }
  return out;
}

/** Debit the account and mint a ticket. Idempotent per key: a replay returns the same ticket. */
export async function spend(kv: Kv, account: string, sink: SinkName, params: unknown = {}, idem?: string): Promise<{ ticket: Ticket; replayed: boolean }> {
  if (!isSink(sink)) throw new Error("unknown sink");
  const cents = SINKS[sink].cents;
  const r: ApplyResult = await apply(kv, account, -cents, "spend", sink, idem);
  const id = "t_" + (idem ? r.entry.id.replace(/-/g, "").slice(0, 24) : randomBytes(12).toString("hex"));
  const existing = await kv.get(ticketKey(id));
  if (existing) return { ticket: JSON.parse(existing) as Ticket, replayed: true };
  const ticket: Ticket = { id, account, sink, params: cleanParams(params), cents, ts: r.entry.ts, status: "unused" };
  await kv.set(ticketKey(id), JSON.stringify(ticket));
  return { ticket, replayed: r.replayed };
}

export async function getTicket(kv: Kv, id: string): Promise<Ticket | null> {
  if (!/^t_[a-f0-9]{24}$/.test(id)) return null;
  const raw = await kv.get(ticketKey(id));
  return raw ? (JSON.parse(raw) as Ticket) : null;
}

/** Peek: true if the ticket exists, is of this sink and is unused. */
export async function ticketUsable(kv: Kv, id: string, sink: SinkName): Promise<boolean> {
  const t = await getTicket(kv, id);
  return !!t && t.sink === sink && t.status === "unused" && !(await kv.get(`cr:redeemed:${id}`));
}

/** Redeem once. The setnx makes concurrent redemptions safe: exactly one caller wins. */
export async function redeemTicket(kv: Kv, id: string, sink: SinkName): Promise<Ticket | null> {
  const t = await getTicket(kv, id);
  if (!t || t.sink !== sink || t.status !== "unused") return null;
  if (!(await kv.setnx(`cr:redeemed:${id}`, "1"))) return null;
  const done: Ticket = { ...t, status: "redeemed" };
  await kv.set(ticketKey(id), JSON.stringify(done));
  return done;
}

export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** One free allowance per account per UTC day. Returns null if already claimed or rate limited. */
export async function claimAllowance(store: Store, account: string, now = Date.now()) {
  if (!(await store.hit(`credits:allow:${account}`, 5, 3600))) return null;
  const r = await apply(store.kv, account, ALLOWANCE_CENTS, "allowance", "daily allowance", `allowance:${dayKey(now)}`);
  return r.replayed ? null : r.entry;
}
