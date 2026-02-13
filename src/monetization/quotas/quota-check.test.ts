import { describe, expect, it } from "vitest";
import { buildQuotaUsage, checkInstanceQuota, type QuotaEnforcementConfig } from "./quota-check.js";
import type { PlanTier } from "./tier-definitions.js";

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
});
