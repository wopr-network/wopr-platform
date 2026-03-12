import { RateStore } from "@wopr-network/platform-core/admin/rates/rate-store";
import { createPublicPricingRoutes } from "@wopr-network/platform-core/api/routes/public-pricing";
import { getDb } from "@wopr-network/platform-core/fleet/services";

let _store: RateStore | null = null;
function getStore(): RateStore {
  if (!_store) {
    _store = new RateStore(getDb());
  }
  return _store;
}

/** Pre-built public pricing routes for wopr-platform. */
export const publicPricingRoutes = createPublicPricingRoutes(getStore);

// Re-export factory for other brands
export { createPublicPricingRoutes } from "@wopr-network/platform-core/api/routes/public-pricing";
