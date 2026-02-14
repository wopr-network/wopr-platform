import { describe, expect, it, vi } from "vitest";
import {
  CREDIT_PRICE_POINTS,
  getConfiguredPriceIds,
  getCreditAmountForPurchase,
  loadCreditPriceMap,
  lookupCreditPrice,
} from "./credit-prices.js";

describe("CREDIT_PRICE_POINTS", () => {
  it("has 5 tiers", () => {
    expect(CREDIT_PRICE_POINTS).toHaveLength(5);
  });

  it("tiers have correct bonus percentages", () => {
    expect(CREDIT_PRICE_POINTS[0].bonusPercent).toBe(0);
    expect(CREDIT_PRICE_POINTS[1].bonusPercent).toBe(0);
    expect(CREDIT_PRICE_POINTS[2].bonusPercent).toBe(2);
    expect(CREDIT_PRICE_POINTS[3].bonusPercent).toBe(5);
    expect(CREDIT_PRICE_POINTS[4].bonusPercent).toBe(10);
  });

  it("credit amounts include bonus correctly", () => {
    expect(CREDIT_PRICE_POINTS[0].creditCents).toBe(500);
    expect(CREDIT_PRICE_POINTS[2].creditCents).toBe(2550);
    expect(CREDIT_PRICE_POINTS[4].creditCents).toBe(11000);
  });
});

describe("getCreditAmountForPurchase", () => {
  it("returns bonus credits for matching tier", () => {
    expect(getCreditAmountForPurchase(2500)).toBe(2550);
    expect(getCreditAmountForPurchase(5000)).toBe(5250);
    expect(getCreditAmountForPurchase(10000)).toBe(11000);
  });

  it("returns 1:1 for non-matching amount", () => {
    expect(getCreditAmountForPurchase(7777)).toBe(7777);
    expect(getCreditAmountForPurchase(1)).toBe(1);
    expect(getCreditAmountForPurchase(99999)).toBe(99999);
  });

  it("returns exact amount for tiers without bonus", () => {
    expect(getCreditAmountForPurchase(500)).toBe(500);
    expect(getCreditAmountForPurchase(1000)).toBe(1000);
  });
});

describe("loadCreditPriceMap", () => {
  it("loads prices from environment variables", () => {
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_5_test");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "price_25_test");

    const map = loadCreditPriceMap();
    expect(map.get("price_5_test")).toEqual(expect.objectContaining({ amountCents: 500, creditCents: 500 }));
    expect(map.get("price_25_test")).toEqual(expect.objectContaining({ amountCents: 2500, creditCents: 2550 }));

    vi.unstubAllEnvs();
  });

  it("skips unset environment variables", () => {
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "");

    const map = loadCreditPriceMap();
    expect(map.size).toBe(0);

    vi.unstubAllEnvs();
  });
});

describe("lookupCreditPrice", () => {
  it("returns price point for known price ID", () => {
    const priceMap = new Map([["price_abc", CREDIT_PRICE_POINTS[2]]]);

    const point = lookupCreditPrice(priceMap, "price_abc");
    expect(point).not.toBeNull();
    expect(point?.amountCents).toBe(2500);
  });

  it("returns null for unknown price ID", () => {
    const priceMap = new Map();
    expect(lookupCreditPrice(priceMap, "price_unknown")).toBeNull();
  });
});

describe("getConfiguredPriceIds", () => {
  it("returns configured price IDs from env", () => {
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "price_5_id");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "price_100_id");

    const ids = getConfiguredPriceIds();
    expect(ids).toContain("price_5_id");
    expect(ids).toContain("price_100_id");

    vi.unstubAllEnvs();
  });

  it("returns empty array when no prices configured", () => {
    vi.stubEnv("STRIPE_CREDIT_PRICE_5", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_10", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_25", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_50", "");
    vi.stubEnv("STRIPE_CREDIT_PRICE_100", "");

    const ids = getConfiguredPriceIds();
    expect(ids).toHaveLength(0);

    vi.unstubAllEnvs();
  });
});
