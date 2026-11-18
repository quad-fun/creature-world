// x402-READY STUB. Shape of the 402 reply only. Real verification and on-chain settlement are NOT implemented:
// with any provider other than "fake", payment headers are refused outright.
export const NOTE_PRICE_USDC_UNITS = "10000"; // 0.01 USDC (6 decimals)

export function paymentRequired(resource: string, env: Record<string, string | undefined> = process.env) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia", // testnet only
        maxAmountRequired: NOTE_PRICE_USDC_UNITS,
        asset: "USDC",
        payTo: env.X402_PAY_TO || "0x0000000000000000000000000000000000000000 (PLACEHOLDER: not configured)",
        resource,
        description: "Deliver one note to a creature (testnet stub)",
        mimeType: "application/json",
        maxTimeoutSeconds: 60,
      },
    ],
    notice: "TEST ONLY. Real verification and settlement are not implemented. With the fake provider send X-PAYMENT: FAKE-TEST-PAYMENT:<nonce>.",
  };
}
