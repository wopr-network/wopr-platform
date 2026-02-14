import { describe, expect, it } from "vitest";
import { checkInstanceQuota, type InstanceLimits, type QuotaEnforcementConfig } from "./quota-check.js";

const freeLimits: InstanceLimits = {
  maxInstances: 1,
  label: "free",
};

const proLimits: InstanceLimits = {
  maxInstances: 5,
  label: "pro",
};

const unlimitedLimits: InstanceLimits = {
  maxInstances: 0, // unlimited
  label: "credit",
};

describe("checkInstanceQuota", () => {
  it("allows creation when under the limit", () => {
    const result = checkInstanceQuota(freeLimits, 0);
    expect(result.allowed).toBe(true);
    expect(result.currentInstances).toBe(0);
    expect(result.maxInstances).toBe(1);
    expect(result.inGracePeriod).toBe(false);
  });

  it("rejects creation when at the limit (hard enforcement)", () => {
    const result = checkInstanceQuota(freeLimits, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Instance quota exceeded");
    expect(result.reason).toContain("1/1");
    expect(result.reason).toContain("free");
  });

  it("rejects creation when over the limit", () => {
    const result = checkInstanceQuota(freeLimits, 5);
    expect(result.allowed).toBe(false);
  });

  it("allows creation for unlimited limits (maxInstances=0)", () => {
    const result = checkInstanceQuota(unlimitedLimits, 100);
    expect(result.allowed).toBe(true);
    expect(result.inGracePeriod).toBe(false);
  });

  it("allows creation for pro limits under limit", () => {
    const result = checkInstanceQuota(proLimits, 3);
    expect(result.allowed).toBe(true);
  });

  it("rejects pro limits at limit", () => {
    const result = checkInstanceQuota(proLimits, 5);
    expect(result.allowed).toBe(false);
  });

  describe("soft cap", () => {
    const softConfig: QuotaEnforcementConfig = {
      softCapEnabled: true,
      gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
    };

    it("allows one over the limit with soft cap and no prior grace", () => {
      const result = checkInstanceQuota(freeLimits, 1, softConfig, null);
      expect(result.allowed).toBe(true);
      expect(result.inGracePeriod).toBe(true);
    });

    it("allows during active grace period", () => {
      const graceStart = new Date(Date.now() - 1000); // started 1 second ago
      const result = checkInstanceQuota(freeLimits, 1, softConfig, graceStart);
      expect(result.allowed).toBe(true);
      expect(result.inGracePeriod).toBe(true);
    });

    it("rejects after grace period expires", () => {
      const graceStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      const result = checkInstanceQuota(freeLimits, 1, softConfig, graceStart);
      expect(result.allowed).toBe(false);
      expect(result.inGracePeriod).toBe(false);
    });

    it("rejects when over limit even with soft cap (only allows exactly at limit)", () => {
      const result = checkInstanceQuota(freeLimits, 2, softConfig, null);
      expect(result.allowed).toBe(false);
    });
  });
});
