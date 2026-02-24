import { describe, expect, it } from "vitest";
import { DEFAULT_STORAGE_TIER, STORAGE_TIER_KEYS, STORAGE_TIERS } from "./storage-tiers.js";

describe("storage-tiers", () => {
  it("defines exactly 4 tiers", () => {
    expect(STORAGE_TIER_KEYS).toHaveLength(4);
    expect(STORAGE_TIER_KEYS).toEqual(["standard", "plus", "pro", "max"]);
  });

  it("default tier is standard", () => {
    expect(DEFAULT_STORAGE_TIER).toBe("standard");
  });

  it("standard tier has zero daily cost", () => {
    expect(STORAGE_TIERS.standard.dailyCostCents).toBe(0);
  });

  it("standard tier has 5GB limit", () => {
    expect(STORAGE_TIERS.standard.storageLimitGb).toBe(5);
  });

  it("tiers are ordered by ascending cost", () => {
    const costs = STORAGE_TIER_KEYS.map((k) => STORAGE_TIERS[k].dailyCostCents);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1]);
    }
  });

  it("tiers are ordered by ascending storage", () => {
    const sizes = STORAGE_TIER_KEYS.map((k) => STORAGE_TIERS[k].storageLimitGb);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("max tier has 100GB limit at 15 credits/day", () => {
    expect(STORAGE_TIERS.max.storageLimitGb).toBe(100);
    expect(STORAGE_TIERS.max.dailyCostCents).toBe(15);
  });
});
