// Payment provider interface. Only the FakeProvider does anything. No keys, no on-chain code.
export interface PaymentProvider {
  readonly name: string;
  /** True for providers that move no real money. */
  readonly isTest: boolean;
  /** Start a top-up and return a settled reference (real providers would return a checkout URL instead). */
  createTopUp(account: string, cents: number): Promise<{ status: "succeeded"; ref: string }>;
  /** Check an x402 X-PAYMENT header. Real verification and settlement are NOT implemented. */
  verifyPaymentHeader(header: string): Promise<{ ok: boolean; payer?: string; nonce?: string }>;
}

export const FAKE_HEADER_PREFIX = "FAKE-TEST-PAYMENT:";

export class FakeProvider implements PaymentProvider {
  readonly name = "fake";
  readonly isTest = true;
  async createTopUp(_account: string, cents: number) {
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("bad amount");
    return { status: "succeeded" as const, ref: `TEST-topup-${Date.now().toString(36)}` };
  }
  async verifyPaymentHeader(header: string) {
    const m = /^FAKE-TEST-PAYMENT:([A-Za-z0-9_-]{6,64})$/.exec(header.trim());
    return m ? { ok: true, payer: "test-payer", nonce: m[1] } : { ok: false };
  }
}

/** Placeholder for Stripe card or USDC. Intentionally unimplemented. */
export class UnconfiguredProvider implements PaymentProvider {
  readonly isTest = false;
  constructor(readonly name: string) {}
  async createTopUp(): Promise<never> {
    throw new Error("payment provider not configured");
  }
  async verifyPaymentHeader(): Promise<never> {
    throw new Error("payment provider not configured");
  }
}

export function getProvider(env: Record<string, string | undefined> = process.env): PaymentProvider {
  const n = (env.PAYMENTS_PROVIDER || "fake").toLowerCase();
  return n === "fake" ? new FakeProvider() : new UnconfiguredProvider(n);
}
