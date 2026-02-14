import { describe, expect, it } from "vitest";
import { buildResourceLimits } from "./resource-limits.js";
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
  maxSpendPerHour: 0.5,
  maxSpendPerMonth: 5,
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
  features: [],
  maxSpendPerHour: 10,
  maxSpendPerMonth: 200,
};

describe("buildResourceLimits", () => {
  it("converts free tier to Docker resource constraints", () => {
    const limits = buildResourceLimits(freeTier);
    expect(limits.Memory).toBe(512 * 1024 * 1024); // 536870912 bytes
    expect(limits.CpuQuota).toBe(50_000);
    expect(limits.PidsLimit).toBe(128);
  });

  it("converts pro tier to Docker resource constraints", () => {
    const limits = buildResourceLimits(proTier);
    expect(limits.Memory).toBe(2048 * 1024 * 1024); // 2147483648 bytes
    expect(limits.CpuQuota).toBe(200_000);
    expect(limits.PidsLimit).toBe(512);
  });

  it("correctly calculates memory in bytes", () => {
    const limits = buildResourceLimits(freeTier);
    // 512 MB = 512 * 1024 * 1024 = 536870912
    expect(limits.Memory).toBe(536_870_912);
  });
});
