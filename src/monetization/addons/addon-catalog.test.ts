import { describe, expect, it } from "vitest";
import { Credit } from "../credit.js";
import { ADDON_CATALOG, ADDON_KEYS, type AddonKey } from "./addon-catalog.js";

describe("addon-catalog", () => {
  it("ADDON_KEYS contains all expected keys", () => {
    expect(ADDON_KEYS).toEqual(["gpu_acceleration", "priority_queue", "extra_storage", "custom_domain"]);
  });

  it("every ADDON_KEYS entry has a matching ADDON_CATALOG definition", () => {
    for (const key of ADDON_KEYS) {
      const def = ADDON_CATALOG[key];
      expect(def).toBeDefined();
      expect(def.key).toBe(key);
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.dailyCost).toBeInstanceOf(Credit);
    }
  });

  it("gpu_acceleration costs 50 cents/day", () => {
    expect(ADDON_CATALOG.gpu_acceleration.dailyCost.equals(Credit.fromCents(50))).toBe(true);
  });

  it("priority_queue costs 20 cents/day", () => {
    expect(ADDON_CATALOG.priority_queue.dailyCost.equals(Credit.fromCents(20))).toBe(true);
  });

  it("extra_storage costs 10 cents/day", () => {
    expect(ADDON_CATALOG.extra_storage.dailyCost.equals(Credit.fromCents(10))).toBe(true);
  });

  it("custom_domain costs 5 cents/day", () => {
    expect(ADDON_CATALOG.custom_domain.dailyCost.equals(Credit.fromCents(5))).toBe(true);
  });

  it("looking up an unknown key returns undefined", () => {
    expect(ADDON_CATALOG["nonexistent" as AddonKey]).toBeUndefined();
  });
});
