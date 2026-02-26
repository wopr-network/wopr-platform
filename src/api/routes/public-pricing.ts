import { Hono } from "hono";
import { RateStore } from "../../admin/rates/rate-store.js";
import { getDb } from "../../fleet/services.js";

let _store: RateStore | null = null;
function getStore(): RateStore {
  if (!_store) {
    _store = new RateStore(getDb());
  }
  return _store;
}

/**
 * GET /api/v1/pricing
 *
 * Public endpoint returning active sell rates grouped by capability.
 * Used by the pricing page (wopr-platform-ui) to replace hardcoded pricingData.
 */
// BOUNDARY(WOP-805): REST is the correct layer for public pricing.
// Unauthenticated, consumed by the marketing/pricing page.
// No session context needed.
export const publicPricingRoutes = new Hono();

publicPricingRoutes.get("/", async (c) => {
  try {
    const store = getStore();
    const rates = await store.listPublicRates();

    // Group by capability for the UI
    const grouped: Record<string, Array<{ name: string; unit: string; price: number }>> = {};
    for (const rate of rates) {
      if (!grouped[rate.capability]) grouped[rate.capability] = [];
      grouped[rate.capability].push({
        name: rate.display_name,
        unit: rate.unit,
        price: rate.price_usd,
      });
    }

    return c.json({ rates: grouped });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});
