/**
 * Middleware that hydrates GatewayTenant.spendingCaps from the spending
 * limits repository (tenant_spending_limits table).
 *
 * Bridges the gap between admin-configured hardCap values stored via
 * DrizzleSpendingLimitsRepository and the gateway's spending cap
 * enforcement middleware (spending-cap.ts).
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { LRUCache } from "lru-cache";
import type {
  ISpendingLimitsRepository,
  SpendingLimitsData,
} from "../monetization/drizzle-spending-limits-repository.js";
import type { SpendingCaps } from "./spending-cap.js";
import type { GatewayTenant } from "./types.js";

export interface HydrateSpendingCapsConfig {
  /** Cache TTL in ms. Default 30_000 (30 seconds). */
  cacheTtlMs: number;
  /** Max cache entries. Default 1000. */
  cacheMaxSize: number;
}

const DEFAULT_CONFIG: HydrateSpendingCapsConfig = {
  cacheTtlMs: 30_000,
  cacheMaxSize: 1000,
};

/**
 * Create middleware that reads spending limits from the DB and sets
 * GatewayTenant.spendingCaps so the downstream spendingCapCheck
 * middleware can enforce them.
 */
export function hydrateSpendingCaps(
  repo: ISpendingLimitsRepository,
  config?: Partial<HydrateSpendingCapsConfig>,
): MiddlewareHandler {
  const cfg: HydrateSpendingCapsConfig = { ...DEFAULT_CONFIG, ...config };

  const cache = new LRUCache<string, SpendingLimitsData>({
    max: cfg.cacheMaxSize,
    ttl: cfg.cacheTtlMs,
  });

  return async (c: Context, next: Next) => {
    const tenant = c.get("gatewayTenant") as GatewayTenant | undefined;
    if (!tenant) return next();

    let limits = cache.get(tenant.id);
    if (!limits) {
      try {
        limits = await repo.get(tenant.id);
        cache.set(tenant.id, limits);
      } catch {
        // Fail open — log and proceed without caps
        return next();
      }
    }

    const hardCap = limits.global.hardCap;
    if (hardCap !== null) {
      const spendingCaps: SpendingCaps = { dailyCapUsd: null, monthlyCapUsd: hardCap };
      c.set("gatewayTenant", { ...tenant, spendingCaps });
    }

    return next();
  };
}
