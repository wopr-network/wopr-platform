import { describe, expect, it } from "vitest";
import { buildQuotaUsage, checkInstanceQuota, checkSpendLimit, type QuotaEnforcementConfig } from "./quota-check.js";
import type { PlanTier, SpendOverride } from "./tier-definitions.js";

const freeTier: PlanTier = {
  id: "free",
  name: "free",
  maxInstances: 1,
  maxPluginsPerInstance: 5,
  memoryLimitMb: 512,
  cpuQuota: 50_000,
  storageLimitMb: 1024,
  maxProcesses: 128,
  features: [],
  maxSpendPerHour: 0.5,
  maxSpendPerMonth: 5,
  platformFeeUsd: 0,
  includedTokens: 50_000,
  overageMarkupPercent: 20,
  byokAllowed: false,
};

const proTier: PlanTier = {
  id: "pro",
  name: "pro",
  maxInstances: 5,
  maxPluginsPerInstance: null,
  memoryLimitMb: 2048,
  cpuQuota: 200_000,
  storageLimitMb: 10_240,
  maxProcesses: 512,
  features: ["priority-support"],
  maxSpendPerHour: 10,
  maxSpendPerMonth: 200,
  platformFeeUsd: 19,
  includedTokens: 2_000_000,
  overageMarkupPercent: 10,
  byokAllowed: true,
};

const enterpriseTier: PlanTier = {
  id: "enterprise",
  name: "enterprise",
  maxInstances: 0, // unlimited
  maxPluginsPerInstance: null,
  memoryLimitMb: 16_384,
  cpuQuota: 800_000,
  storageLimitMb: 102_400,
  maxProcesses: 4096,
  features: [],
  maxSpendPerHour: null,
  maxSpendPerMonth: null,
  platformFeeUsd: 0,
  includedTokens: 0,
  overageMarkupPercent: 5,
  byokAllowed: true,
};

describe("checkInstanceQuota", () => {
  it("allows creation when under the limit", () => {
    const result = checkInstanceQuota(freeTier, 0);
    expect(result.allowed).toBe(true);
    expect(result.currentInstances).toBe(0);
    expect(result.maxInstances).toBe(1);
    expect(result.inGracePeriod).toBe(false);
  });

  it("rejects creation when at the limit (hard enforcement)", () => {
    const result = checkInstanceQuota(freeTier, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Instance quota exceeded");
    expect(result.reason).toContain("1/1");
    expect(result.reason).toContain("free");
  });

  it("rejects creation when over the limit", () => {
    const result = checkInstanceQuota(freeTier, 5);
    expect(result.allowed).toBe(false);
  });

  it("allows creation for unlimited tier (maxInstances=0)", () => {
    const result = checkInstanceQuota(enterpriseTier, 100);
    expect(result.allowed).toBe(true);
    expect(result.inGracePeriod).toBe(false);
  });

  it("allows creation for pro tier under limit", () => {
    const result = checkInstanceQuota(proTier, 3);
    expect(result.allowed).toBe(true);
  });

  it("rejects pro tier at limit", () => {
    const result = checkInstanceQuota(proTier, 5);
    expect(result.allowed).toBe(false);
  });

  describe("soft cap", () => {
    const softConfig: QuotaEnforcementConfig = {
      softCapEnabled: true,
      gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
    };

    it("allows one over the limit with soft cap and no prior grace", () => {
      const result = checkInstanceQuota(freeTier, 1, softConfig, null);
      expect(result.allowed).toBe(true);
      expect(result.inGracePeriod).toBe(true);
    });

    it("allows during active grace period", () => {
      const graceStart = new Date(Date.now() - 1000); // started 1 second ago
      const result = checkInstanceQuota(freeTier, 1, softConfig, graceStart);
      expect(result.allowed).toBe(true);
      expect(result.inGracePeriod).toBe(true);
    });

    it("rejects after grace period expires", () => {
      const graceStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      const result = checkInstanceQuota(freeTier, 1, softConfig, graceStart);
      expect(result.allowed).toBe(false);
      expect(result.inGracePeriod).toBe(false);
    });

    it("rejects when over limit even with soft cap (only allows exactly at limit)", () => {
      const result = checkInstanceQuota(freeTier, 2, softConfig, null);
      expect(result.allowed).toBe(false);
    });
  });
});

describe("buildQuotaUsage", () => {
  it("returns correct usage for free tier with 0 instances", () => {
    const usage = buildQuotaUsage(freeTier, 0);
    expect(usage.tier).toEqual(freeTier);
    expect(usage.instances.current).toBe(0);
    expect(usage.instances.max).toBe(1);
    expect(usage.instances.remaining).toBe(1);
    expect(usage.resources.memoryLimitMb).toBe(512);
    expect(usage.resources.cpuQuota).toBe(50_000);
  });

  it("returns remaining=0 when at limit", () => {
    const usage = buildQuotaUsage(freeTier, 1);
    expect(usage.instances.remaining).toBe(0);
  });

  it("returns remaining=-1 for unlimited tier", () => {
    const usage = buildQuotaUsage(enterpriseTier, 50);
    expect(usage.instances.remaining).toBe(-1);
    expect(usage.instances.max).toBe(0);
  });

  it("returns null for unlimited plugins", () => {
    const usage = buildQuotaUsage(proTier, 2);
    expect(usage.resources.maxPluginsPerInstance).toBeNull();
  });

  it("includes spending limits from tier", () => {
    const usage = buildQuotaUsage(freeTier, 0);
    expect(usage.spending.maxSpendPerHour).toBe(0.5);
    expect(usage.spending.maxSpendPerMonth).toBe(5);
  });

  it("returns null spending limits for unlimited tier", () => {
    const usage = buildQuotaUsage(enterpriseTier, 0);
    expect(usage.spending.maxSpendPerHour).toBeNull();
    expect(usage.spending.maxSpendPerMonth).toBeNull();
  });
});

describe("checkSpendLimit", () => {
  it("allows when under both hourly and monthly limits", () => {
    const result = checkSpendLimit(freeTier, 0.1, 2.0);
    expect(result.allowed).toBe(true);
    expect(result.exceededLimit).toBeNull();
    expect(result.currentHourlySpend).toBe(0.1);
    expect(result.currentMonthlySpend).toBe(2.0);
    expect(result.maxSpendPerHour).toBe(0.5);
    expect(result.maxSpendPerMonth).toBe(5);
  });

  it("rejects when hourly limit is exceeded", () => {
    const result = checkSpendLimit(freeTier, 0.55, 1.0);
    expect(result.allowed).toBe(false);
    expect(result.exceededLimit).toBe("hourly");
    expect(result.httpStatus).toBe(402);
    expect(result.reason).toContain("Hourly spending limit exceeded");
    expect(result.reason).toContain("$0.55/$0.50");
    expect(result.reason).toContain("Upgrade");
  });

  it("rejects when monthly limit is exceeded", () => {
    const result = checkSpendLimit(freeTier, 0.1, 5.5);
    expect(result.allowed).toBe(false);
    expect(result.exceededLimit).toBe("monthly");
    expect(result.httpStatus).toBe(402);
    expect(result.reason).toContain("Monthly spending limit exceeded");
    expect(result.reason).toContain("$5.50/$5.00");
  });

  it("rejects at exact hourly limit", () => {
    const result = checkSpendLimit(freeTier, 0.5, 1.0);
    expect(result.allowed).toBe(false);
    expect(result.exceededLimit).toBe("hourly");
  });

  it("rejects at exact monthly limit", () => {
    const result = checkSpendLimit(freeTier, 0.1, 5.0);
    expect(result.allowed).toBe(false);
    expect(result.exceededLimit).toBe("monthly");
  });

  it("checks hourly before monthly (hourly is more urgent)", () => {
    // Both limits exceeded -- should report hourly
    const result = checkSpendLimit(freeTier, 0.6, 6.0);
    expect(result.allowed).toBe(false);
    expect(result.exceededLimit).toBe("hourly");
  });

  it("allows unlimited tier (enterprise) regardless of spend", () => {
    const result = checkSpendLimit(enterpriseTier, 1000, 50_000);
    expect(result.allowed).toBe(true);
    expect(result.exceededLimit).toBeNull();
    expect(result.maxSpendPerHour).toBeNull();
    expect(result.maxSpendPerMonth).toBeNull();
  });

  it("uses pro tier limits correctly", () => {
    const underLimit = checkSpendLimit(proTier, 5, 100);
    expect(underLimit.allowed).toBe(true);

    const overHourly = checkSpendLimit(proTier, 11, 100);
    expect(overHourly.allowed).toBe(false);
    expect(overHourly.exceededLimit).toBe("hourly");

    const overMonthly = checkSpendLimit(proTier, 5, 201);
    expect(overMonthly.allowed).toBe(false);
    expect(overMonthly.exceededLimit).toBe("monthly");
  });

  describe("per-tenant overrides", () => {
    const tenantOverride: SpendOverride = {
      tenant: "tenant-1",
      maxSpendPerHour: 2.0,
      maxSpendPerMonth: 20,
      notes: "VIP customer",
      updatedAt: Date.now(),
    };

    it("override takes precedence over tier defaults", () => {
      // Free tier default is $0.50/hr, but override raises to $2.00/hr
      const result = checkSpendLimit(freeTier, 1.0, 3.0, tenantOverride);
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBe(2.0);
      expect(result.maxSpendPerMonth).toBe(20);
    });

    it("rejects when override limit is exceeded", () => {
      const result = checkSpendLimit(freeTier, 2.5, 3.0, tenantOverride);
      expect(result.allowed).toBe(false);
      expect(result.exceededLimit).toBe("hourly");
      expect(result.maxSpendPerHour).toBe(2.0);
    });

    it("null override fields fall back to tier defaults", () => {
      const partialOverride: SpendOverride = {
        tenant: "tenant-2",
        maxSpendPerHour: null, // falls back to tier
        maxSpendPerMonth: 50, // overrides tier
        notes: null,
        updatedAt: Date.now(),
      };
      const result = checkSpendLimit(freeTier, 0.1, 3.0, partialOverride);
      expect(result.allowed).toBe(true);
      expect(result.maxSpendPerHour).toBe(0.5); // from tier
      expect(result.maxSpendPerMonth).toBe(50); // from override
    });

    it("null override is treated like no override", () => {
      const result = checkSpendLimit(freeTier, 0.6, 1.0, null);
      expect(result.allowed).toBe(false);
      expect(result.maxSpendPerHour).toBe(0.5);
    });
  });
});
