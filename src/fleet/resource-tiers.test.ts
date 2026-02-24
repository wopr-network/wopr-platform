import { describe, expect, it } from "vitest";
import { DEFAULT_RESOURCE_TIER, RESOURCE_TIER_KEYS, RESOURCE_TIERS, tierToResourceLimits } from "./resource-tiers.js";

describe("resource-tiers", () => {
  it("defines exactly 4 tiers", () => {
    expect(RESOURCE_TIER_KEYS).toHaveLength(4);
    expect(RESOURCE_TIER_KEYS).toEqual(["standard", "pro", "power", "beast"]);
  });

  it("default tier is standard", () => {
    expect(DEFAULT_RESOURCE_TIER).toBe("standard");
  });

  it("standard tier has zero daily cost", () => {
    expect(RESOURCE_TIERS.standard.dailyCostCents).toBe(0);
  });

  it("tiers are ordered by ascending cost", () => {
    const costs = RESOURCE_TIER_KEYS.map((k) => RESOURCE_TIERS[k].dailyCostCents);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1]);
    }
  });

  it("converts tier to ContainerResourceLimits", () => {
    const limits = tierToResourceLimits("pro");
    expect(limits.Memory).toBe(4096 * 1024 * 1024);
    expect(limits.CpuQuota).toBe(400_000);
    expect(limits.PidsLimit).toBe(1024);
  });

  it("converts standard tier to default resource limits", () => {
    const limits = tierToResourceLimits("standard");
    expect(limits.Memory).toBe(2048 * 1024 * 1024);
    expect(limits.CpuQuota).toBe(200_000);
    expect(limits.PidsLimit).toBe(512);
  });
});
