import type DatabaseType from "better-sqlite3";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { RateStore } from "../../admin/rates/rate-store.js";
import { initRateSchema } from "../../admin/rates/schema.js";
import { applyPlatformPragmas } from "../../db/pragmas.js";

const RATES_DB_PATH = process.env.RATES_DB_PATH || "/data/platform/rates.db";

/** Lazy-initialized rates database (avoids opening DB at module load time). */
let _ratesDb: DatabaseType.Database | null = null;
function getRatesDb(): DatabaseType.Database {
  if (!_ratesDb) {
    _ratesDb = new Database(RATES_DB_PATH);
    applyPlatformPragmas(_ratesDb);
    initRateSchema(_ratesDb);
  }
  return _ratesDb;
}

let _store: RateStore | null = null;
function getStore(): RateStore {
  if (!_store) {
    _store = new RateStore(getRatesDb());
  }
  return _store;
}

/**
 * GET /api/v1/pricing
 *
 * Public endpoint returning active sell rates grouped by capability.
 * Used by the pricing page (wopr-platform-ui) to replace hardcoded pricingData.
 */
export const publicPricingRoutes = new Hono();

publicPricingRoutes.get("/", (c) => {
  try {
    const store = getStore();
    const rates = store.listPublicRates();

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
