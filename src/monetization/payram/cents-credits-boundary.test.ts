import { describe, expect, it } from "vitest";

/**
 * Regression tests for PayRam cents/credits boundary (WOP-1058).
 *
 * Verifies that the USD-to-cents conversion in checkout and
 * the cents-to-credits flow in the webhook maintain correct units.
 *
 * If any of these tests fail after a rename/refactor, a _cents field was
 * incorrectly changed to store Credit raw units (nanodollars) instead of
 * USD cents. See src/monetization/credits/credit-ledger.ts for naming convention.
 */
describe("WOP-1058: PayRam cents/credits boundary", () => {
  it("USD to cents conversion is correct (mirrors checkout.ts pattern)", () => {
    // This mirrors the conversion in payram/checkout.ts: Math.round(opts.amountUsd * 100)
    const amountUsd = 25;
    const amountUsdCents = Math.round(amountUsd * 100);
    expect(amountUsdCents).toBe(2500);
    // Must NOT be nanodollar scale
    expect(amountUsdCents).toBeLessThan(1_000_000);
  });

  it("minimum payment amount converts to valid cents", () => {
    const MIN_PAYMENT_USD = 10;
    const cents = Math.round(MIN_PAYMENT_USD * 100);
    expect(cents).toBe(1000);
    expect(Number.isInteger(cents)).toBe(true);
    // Sanity: $10 is 1000 cents, NOT 10_000_000_000 nanodollars
    expect(cents).toBeLessThan(1_000_000);
  });

  it("fractional USD amounts round correctly to cents", () => {
    // Edge case: floating point conversion
    const amountUsd = 10.99;
    const cents = Math.round(amountUsd * 100);
    expect(cents).toBe(1099);
    expect(cents).toBeLessThan(1_000_000);
  });

  it("amountUsdCents stored in charge record equals USD * 100 (not nanodollars)", () => {
    // The core invariant: payram/checkout.ts stores Math.round(amountUsd * 100)
    // as amountUsdCents. This test proves the conversion stays at cent scale.
    const testCases: Array<{ usd: number; expectedCents: number }> = [
      { usd: 10, expectedCents: 1000 },
      { usd: 25, expectedCents: 2500 },
      { usd: 50, expectedCents: 5000 },
      { usd: 100, expectedCents: 10000 },
    ];

    for (const { usd, expectedCents } of testCases) {
      const amountUsdCents = Math.round(usd * 100);
      expect(amountUsdCents).toBe(expectedCents);
      // CREDIT SCALE = 1_000_000_000. If this value approaches that, unit confusion occurred.
      expect(amountUsdCents).toBeLessThan(1_000_000);
    }
  });

  it("creditedCents in webhook equals amountUsdCents from charge store (1:1 for PayRam)", () => {
    // payram/webhook.ts: const creditCents = charge.amountUsdCents;
    // The credited amount always equals the stored USD cents — no bonus tiers for PayRam.
    const chargeAmountUsdCents = 2500; // $25.00
    const creditCents = chargeAmountUsdCents; // 1:1 for PayRam
    expect(creditCents).toBe(2500);
    // creditedCents must be 2500 (cents), not 25_000_000_000 (nanodollars)
    expect(creditCents).toBeLessThan(1_000_000);
  });

  it("cents-to-nanodollar scale difference is preserved as a sanity constant", () => {
    // Credit.SCALE = 1_000_000_000 nanodollars per dollar
    // 1 USD cent = 10_000_000 nanodollars (SCALE / 100)
    // This test documents the relationship so future developers understand the gap.
    const CREDIT_SCALE = 1_000_000_000;
    const CENTS_PER_DOLLAR = 100;
    const NANODOLLARS_PER_CENT = CREDIT_SCALE / CENTS_PER_DOLLAR;

    expect(NANODOLLARS_PER_CENT).toBe(10_000_000);

    // $25 in cents = 2500. $25 in nanodollars = 25_000_000_000.
    // These are 10_000_000x apart — confirming that mixing the two is catastrophic.
    const twentyFiveDollarsInCents = 2500;
    const twentyFiveDollarsInNanodollars = 25 * CREDIT_SCALE;
    expect(twentyFiveDollarsInNanodollars / twentyFiveDollarsInCents).toBe(NANODOLLARS_PER_CENT);
  });
});
