import { Credit } from "../credit.js";
import { ADDON_CATALOG, type AddonKey } from "./addon-catalog.js";
import type { ITenantAddonRepository } from "./addon-repository.js";

/**
 * Build a `getAddonCosts` callback for the runtime cron.
 * Sums daily costs of all enabled add-ons for a tenant.
 */
export function buildAddonCosts(addonRepo: ITenantAddonRepository): (tenantId: string) => Promise<Credit> {
  return async (tenantId: string): Promise<Credit> => {
    const addons = await addonRepo.list(tenantId);
    let total = Credit.ZERO;
    for (const addon of addons) {
      const def = ADDON_CATALOG[addon.addonKey as AddonKey];
      if (def) {
        total = total.add(def.dailyCost);
      }
    }
    return total;
  };
}
