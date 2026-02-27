import { describe, expect, it } from "vitest";
import { CREDIT_PRICE_POINTS, getCreditAmountForPurchase } from "./credit-prices.js";

/**
 * Regression tests for the cents/credits boundary (WOP-1058).
 *
 * These tests verify that:
 * 1. CreditPricePoint.amountCents values are valid USD cent amounts (not nanodollars)
 * 2. CreditPricePoint.creditCents values are >= amountCents (bonus never negative)
 * 3. getCreditAmountForPurchase returns creditCents (not some other unit)
 * 4. No price point value approaches nanodollar scale (SCALE = 1_000_000_000)
 *
 * If any of these tests fail after a rename/refactor, a _cents field was
 * incorrectly changed to store Credit raw units (nanodollars) instead of
 * USD cents. See src/monetization/credits/credit-ledger.ts for naming convention.
 */
describe("WOP-1058: Stripe cents/credits boundary", () => {
  it("all amountCents values are positive integers representing USD cents", () => {
    for (const point of CREDIT_PRICE_POINTS) {
      expect(point.amountCents).toBeGreaterThan(0);
      expect(Number.isInteger(point.amountCents)).toBe(true);
      // Sanity: no tier charges more than $1000 (100_000 cents)
      expect(point.amountCents).toBeLessThanOrEqual(100_000);
    }
  });

  it("amountCents values are never in nanodollar range (would indicate unit confusion)", () => {
    for (const point of CREDIT_PRICE_POINTS) {
      // Credit.SCALE = 1_000_000_000. If a value is in this range,
      // a _cents field was mistakenly assigned a Credit.toRaw() value.
      expect(point.amountCents).toBeLessThan(1_000_000);
    }
  });

  it("all creditCents values are >= amountCents (bonus is non-negative)", () => {
    for (const point of CREDIT_PRICE_POINTS) {
      expect(point.creditCents).toBeGreaterThanOrEqual(point.amountCents);
    }
  });

  it("creditCents values are never in nanodollar range (would indicate unit confusion)", () => {
    for (const point of CREDIT_PRICE_POINTS) {
      expect(point.creditCents).toBeLessThan(1_000_000);
    }
  });

  it("getCreditAmountForPurchase returns creditCents for known tiers", () => {
    for (const point of CREDIT_PRICE_POINTS) {
      const result = getCreditAmountForPurchase(point.amountCents);
      expect(result).toBe(point.creditCents);
    }
  });

  it("getCreditAmountForPurchase returns input for unknown amounts (1:1 fallback)", () => {
    const unknownAmount = 1234;
    expect(getCreditAmountForPurchase(unknownAmount)).toBe(unknownAmount);
  });

  it("bonus tier percentages produce correct creditCents (not raw credit units)", () => {
    // $25 + 2% bonus = $25.50 = 2550 cents (NOT 25_500_000_000 nanodollars)
    const tier25 = CREDIT_PRICE_POINTS.find((p) => p.amountCents === 2500);
    expect(tier25).toBeDefined();
    expect(tier25?.creditCents).toBe(2550);

    // $100 + 10% bonus = $110 = 11000 cents (NOT 110_000_000_000 nanodollars)
    const tier100 = CREDIT_PRICE_POINTS.find((p) => p.amountCents === 10000);
    expect(tier100).toBeDefined();
    expect(tier100?.creditCents).toBe(11000);
  });
});
