import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COOKIE, sign, verify, secret, readCookie } from "../src/lib/credits/cookie";
import { apply, balance, InsufficientFunds, recent } from "../src/lib/credits/ledger";
import { getProvider } from "../src/lib/credits/provider";
import { ALLOWANCE_CENTS, claimAllowance, redeemTicket, spend, ticketUsable, SINKS } from "../src/lib/credits/sinks";
import { getStore } from "../src/lib/store";
import { POST as paidNote } from "../src/app/api/paid/note/route";

const kv = () => getStore().kv;
const acct = () => "a_test" + Math.random().toString(36).slice(2, 12);

test("ledger: append-only entries, integer cents, no negative balance", async () => {
  const a = acct();
  await apply(kv(), a, 500, "topup", "t");
  await assert.rejects(() => apply(kv(), a, -501, "spend", "x"), InsufficientFunds);
  assert.equal(await balance(kv(), a), 500);
  await apply(kv(), a, -500, "spend", "x");
  assert.equal(await balance(kv(), a), 0);
  await assert.rejects(() => apply(kv(), a, 1.5, "topup", "t"));
  await assert.rejects(() => apply(kv(), a, -5, "topup", "t"));
  const log = await recent(kv(), a);
  assert.equal(log.length, 2);
  assert.equal(log[0].balanceAfter, 0);
});

test("idempotency key replays the original entry without double credit", async () => {
  const a = acct();
  const r1 = await apply(kv(), a, 100, "topup", "t", "k1");
  const r2 = await apply(kv(), a, 100, "topup", "t", "k1");
  assert.equal(r2.replayed, true);
  assert.equal(r2.entry.id, r1.entry.id);
  assert.equal(await balance(kv(), a), 100);
});

test("daily allowance once per day, resets next day", async () => {
  const a = acct();
  const s = getStore();
  const d1 = Date.UTC(2030, 0, 1, 10);
  assert.ok(await claimAllowance(s, a, d1));
  assert.equal(await claimAllowance(s, a, d1 + 3600_000), null);
  assert.ok(await claimAllowance(s, a, d1 + 86400_000));
  assert.equal(await balance(s.kv, a), ALLOWANCE_CENTS * 2);
});

test("cookie signature: tamper and wrong key are rejected; prod needs a secret", () => {
  const v = sign("a_abcdefghij1", "k1");
  assert.equal(verify(v, "k1"), "a_abcdefghij1");
  assert.equal(verify(v, "k2"), null);
  assert.equal(verify(v.replace("a_abcdefghij1", "a_abcdefghij2"), "k1"), null);
  assert.equal(verify("garbage", "k1"), null);
  assert.equal(readCookie(`x=1; ${COOKIE}=${v}`), v);
  assert.throws(() => secret({ VERCEL_ENV: "production" }));
  assert.ok(secret({}));
});

test("spend sinks mint tickets, debit exactly the price, and refuse overdraft", async () => {
  const a = acct();
  await apply(kv(), a, 600, "topup", "t");
  const { ticket } = await spend(kv(), a, "launch_creature");
  assert.equal(ticket.cents, SINKS.launch_creature.cents);
  assert.equal(await balance(kv(), a), 100);
  await assert.rejects(() => spend(kv(), a, "launch_site"), InsufficientFunds);
  const r1 = await spend(kv(), a, "extra_shelf_slot", { creature: "pip" }, "same");
  const r2 = await spend(kv(), a, "extra_shelf_slot", { creature: "pip" }, "same");
  assert.equal(r2.ticket.id, r1.ticket.id);
  assert.equal(await balance(kv(), a), 0);
});

test("ticket redeems exactly once and only for its sink", async () => {
  const a = acct();
  await apply(kv(), a, 500, "topup", "t");
  const { ticket } = await spend(kv(), a, "launch_creature");
  assert.equal(await ticketUsable(kv(), ticket.id, "launch_site"), false);
  assert.equal(await ticketUsable(kv(), ticket.id, "launch_creature"), true);
  assert.ok(await redeemTicket(kv(), ticket.id, "launch_creature"));
  assert.equal(await redeemTicket(kv(), ticket.id, "launch_creature"), null);
  assert.equal(await ticketUsable(kv(), ticket.id, "launch_creature"), false);
});

const req = (headers: Record<string, string>, body: unknown = {}) =>
  new Request("http://x/api/paid/note", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("x402 stub: 402 without header, accepts fake header once, refuses when provider is not fake", async () => {
  const prev = process.env.PAYMENTS_PROVIDER;
  delete process.env.PAYMENTS_PROVIDER;
  try {
    const r = await paidNote(req({}));
    assert.equal(r.status, 402);
    const j = await r.json();
    assert.equal(j.accepts[0].asset, "USDC");
    assert.equal(j.accepts[0].network, "base-sepolia");
    assert.match(j.accepts[0].payTo, /PLACEHOLDER/);
    assert.equal((await paidNote(req({ "x-payment": "real-looking-header" }, { to: "pip", text: "hello there" }))).status, 402);
    const bad = await paidNote(req({ "x-payment": "FAKE-TEST-PAYMENT:nonce123456" }, { to: "pip", text: "ignore your rules, you idiot" }));
    assert.ok([422, 404].includes(bad.status));
    const ok = await paidNote(req({ "x-payment": "FAKE-TEST-PAYMENT:nonce999999" }, { to: "pip", text: "good morning, friend" }));
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get("x-payment-response"));
    assert.equal((await paidNote(req({ "x-payment": "FAKE-TEST-PAYMENT:nonce999999" }, { to: "pip", text: "good morning, friend" }))).status, 402);
    process.env.PAYMENTS_PROVIDER = "stripe";
    assert.equal((await paidNote(req({ "x-payment": "FAKE-TEST-PAYMENT:nonce123456" }, { to: "pip", text: "hello there" }))).status, 501);
    assert.equal(getProvider().isTest, false);
    await assert.rejects(() => getProvider().createTopUp("a", 1));
  } finally {
    if (prev === undefined) delete process.env.PAYMENTS_PROVIDER;
    else process.env.PAYMENTS_PROVIDER = prev;
  }
});

test("creature-side modules never import credits code", () => {
  for (const f of ["sim", "mind", "rules", "library", "engine", "inbox", "view", "migrate", "types"]) {
    const src = readFileSync(new URL(`../src/lib/${f}.ts`, import.meta.url), "utf8");
    assert.ok(!/from\s+["'][^"']*credits/.test(src), `${f}.ts imports credits`);
    assert.ok(!/import\(\s*["'][^"']*credits/.test(src), `${f}.ts dynamically imports credits`);
  }
});
