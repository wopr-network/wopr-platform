import { describe, expect, it } from "vitest";

// We test the schema directly, not the singleton config export,
// because the singleton is already parsed at import time.
// Instead we test the schema shape by importing and re-parsing.

describe("billing env validation", () => {
  it("uses correct defaults when no env vars set", async () => {
    // Dynamic import to test schema defaults
    const { billingConfigSchema } = await import("./index.js");
    const result = billingConfigSchema.parse({});
    expect(result).toEqual({
      affiliateMatchRate: 1.0,
      affiliateMaxReferrals30d: 20,
      affiliateMaxMatchCredits30d: 20000,
      affiliateNewUserBonusRate: 0.2,
      dividendMatchRate: 1.0,
      meterMaxRetries: 3,
    });
  });

  it("coerces valid string values to numbers", async () => {
    const { billingConfigSchema } = await import("./index.js");
    const result = billingConfigSchema.parse({
      affiliateMatchRate: "0.5",
      affiliateMaxReferrals30d: "10",
      affiliateMaxMatchCredits30d: "5000",
      affiliateNewUserBonusRate: "0.15",
      dividendMatchRate: "0.75",
      meterMaxRetries: "5",
    });
    expect(result.affiliateMatchRate).toBe(0.5);
    expect(result.affiliateMaxReferrals30d).toBe(10);
    expect(result.affiliateMaxMatchCredits30d).toBe(5000);
    expect(result.affiliateNewUserBonusRate).toBe(0.15);
    expect(result.dividendMatchRate).toBe(0.75);
    expect(result.meterMaxRetries).toBe(5);
  });

  it("rejects non-numeric strings", async () => {
    const { billingConfigSchema } = await import("./index.js");
    expect(() => billingConfigSchema.parse({ affiliateMatchRate: "not-a-number" })).toThrow();
  });

  it("rejects negative rates", async () => {
    const { billingConfigSchema } = await import("./index.js");
    expect(() => billingConfigSchema.parse({ affiliateMatchRate: "-0.5" })).toThrow();
  });

  it("rejects non-integer retries", async () => {
    const { billingConfigSchema } = await import("./index.js");
    expect(() => billingConfigSchema.parse({ meterMaxRetries: "2.5" })).toThrow();
  });
});
