import { describe, expect, it } from "vitest";
import { Credit } from "../credit.js";
import { ADDON_CATALOG } from "./addon-catalog.js";
import { buildAddonCosts } from "./addon-cron.js";
import type { ITenantAddonRepository, TenantAddon } from "./addon-repository.js";

function makeMockRepo(addons: TenantAddon[]): ITenantAddonRepository {
  return {
    list: async () => addons,
    enable: async () => {},
    disable: async () => {},
    isEnabled: async () => false,
  };
}

function makeAddon(key: string): TenantAddon {
  return { tenantId: "t1", addonKey: key as never, enabledAt: new Date() };
}

describe("buildAddonCosts", () => {
  it("returns Credit.ZERO when tenant has no addons", async () => {
    const getAddonCosts = buildAddonCosts(makeMockRepo([]));
    const result = await getAddonCosts("t1");
    expect(result.equals(Credit.ZERO)).toBe(true);
  });

  it("returns the daily cost of a single addon", async () => {
    const getAddonCosts = buildAddonCosts(makeMockRepo([makeAddon("gpu_acceleration")]));
    const result = await getAddonCosts("t1");
    expect(result.equals(ADDON_CATALOG.gpu_acceleration.dailyCost)).toBe(true);
  });

  it("sums costs of multiple addons", async () => {
    const addons = [makeAddon("gpu_acceleration"), makeAddon("custom_domain")];
    const getAddonCosts = buildAddonCosts(makeMockRepo(addons));
    const result = await getAddonCosts("t1");
    const expected = ADDON_CATALOG.gpu_acceleration.dailyCost.add(ADDON_CATALOG.custom_domain.dailyCost);
    expect(result.equals(expected)).toBe(true);
  });

  it("skips unknown addon keys without throwing", async () => {
    const addons = [makeAddon("gpu_acceleration"), makeAddon("nonexistent_addon")];
    const getAddonCosts = buildAddonCosts(makeMockRepo(addons));
    const result = await getAddonCosts("t1");
    expect(result.equals(ADDON_CATALOG.gpu_acceleration.dailyCost)).toBe(true);
  });

  it("sums all four catalog addons correctly", async () => {
    const addons = [
      makeAddon("gpu_acceleration"),
      makeAddon("priority_queue"),
      makeAddon("extra_storage"),
      makeAddon("custom_domain"),
    ];
    const getAddonCosts = buildAddonCosts(makeMockRepo(addons));
    const result = await getAddonCosts("t1");
    // 50 + 20 + 10 + 5 = 85 cents/day
    expect(result.equals(Credit.fromCents(85))).toBe(true);
  });
});
