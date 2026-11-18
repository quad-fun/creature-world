# Payments: rails only (test mode)

Nothing here moves real money. This is structure so a real provider can be slotted in later. Not legal advice.

## Rails
- Ledger (`src/lib/credits/ledger.ts`): closed-loop USD credits in integer cents. Append-only entries per account, balance kept by atomic increment, rolled back if it would go negative (or above the 10,000 cent cap). Idempotency keys make retries safe. No withdrawals, no transfers between accounts, no refunds to cash.
- Identity (`cookie.ts`): opaque random account id in a signed (HMAC-SHA256) httpOnly cookie. Secret is `CREDITS_SECRET`; a dev fallback exists but is refused when `VERCEL_ENV=production`. No emails, passwords or wallets stored. Clearing cookies loses the account (acceptable in test mode; a real launch needs recovery).
- Provider (`provider.ts`): `PaymentProvider` interface. `FakeProvider` (default, `PAYMENTS_PROVIDER=fake`) credits instantly and is labelled TEST. Any other value selects an unconfigured stub whose methods throw "not configured".
- Sinks (`sinks.ts`): launch_creature 500c, launch_site 300c, extra_shelf_slot 100c, extra_daily_calls 200c. `spend` debits and returns a ticket (entitlement); it never touches the world. Free allowance of 25c per account per UTC day.
- Ticket redemption: `/api/adopt` requires an unused `launch_creature` ticket (body `ticket`) only when `REQUIRE_TICKET=1`. Default off. The other sink tickets are minted but nothing redeems them yet.
- Storage: `store.kv` (Redis keys `cw:kv:cr:*`, or in-memory). Note the ledger shares the world Redis; use a separate database before real money.
- Endpoints: `GET /api/credits/me`, `POST /api/credits/{topup,allowance,spend}`, page `/account`.
- x402 stub (`/api/paid/note`): 402 with payment requirements (0.01 USDC, base-sepolia, payTo from `X402_PAY_TO` or a placeholder). With the fake provider a header `X-PAYMENT: FAKE-TEST-PAYMENT:<nonce>` delivers a note via the normal checkText, rate limits and inbox. With any other provider every payment header is refused (501). Real verification and settlement are NOT implemented.

## Creatures never touch money
Creatures hold in-world coins only. A test asserts that sim, mind, rules, library, engine and related modules do not import `credits`. Spending only produces tickets that humans redeem through HTTP routes.

## Before real money (not exhaustive, not legal advice)
- Legal review of selling stored-value credits (money transmission / e-money, gift card and breakage rules, sales tax or VAT, consumer refund and chargeback terms, terms of service, privacy policy, age gating).
- Choose a processor and merchant-of-record arrangement; use hosted checkout so card data never reaches us; signed webhook handling with idempotency.
- For USDC/x402: real facilitator verification, replay protection, settlement reconciliation, sanctions screening, custody decisions. No private keys in this app.
- Durable, backed-up, separate ledger database with transactional writes and audit/reconciliation jobs; account recovery and fraud/abuse controls; incident process.
- Keep the world server authoritative and cost caps in place regardless of paid entitlements.
