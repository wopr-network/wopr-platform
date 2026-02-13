import type { Context, Next } from "hono";
import type { PlanTier } from "./quotas/tier-definitions.js";
import { type TierName, tierSatisfies } from "./quotas/tier-definitions.js";

/**
 * Callback to resolve the user's current plan tier.
 * Platform wires this up to look up the tier from the auth session / organization.
 */
export type GetUserTier = (userId: string) => PlanTier | Promise<PlanTier>;

export interface FeatureGateConfig {
  /** Resolve the authenticated user's plan tier */
  getUserTier: GetUserTier;
  /** Key on the Hono context where the authenticated user object lives (default: "user") */
  userKey?: string;
  /** Property on the user object that holds the user ID (default: "id") */
  userIdField?: string;
}

/**
 * Create a `requireTier` middleware factory.
 *
 * Usage:
 * ```ts
 * const { requireTier, requireFeature } = createFeatureGate({ getUserTier });
 * app.post('/api/premium', requireAuth, requireTier('pro'), handler);
 * app.post('/api/sso', requireAuth, requireTier('pro'), requireFeature('sso'), handler);
 * ```
 */
export function createFeatureGate(cfg: FeatureGateConfig) {
  const userKey = cfg.userKey ?? "user";
  const userIdField = cfg.userIdField ?? "id";

  /**
   * Middleware that rejects requests when the user's tier is below `minTier`.
   * On success, sets `c.set('tier', tier)` for downstream handlers.
   */
  const requireTier = (minTier: TierName) => {
    return async (c: Context, next: Next) => {
      const user = c.get(userKey) as Record<string, unknown> | undefined;
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const userId = user[userIdField] as string | undefined;
      if (!userId) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const tier = await cfg.getUserTier(userId);
      if (!tierSatisfies(tier.name, minTier)) {
        return c.json(
          {
            error: "Upgrade required",
            required: minTier,
            current: tier.name,
            upgradeUrl: "/settings/billing",
          },
          403,
        );
      }

      c.set("tier", tier);
      return next();
    };
  };

  /**
   * Middleware that rejects requests when the user's tier does not include `feature`.
   * If `requireTier` ran first, reuses the tier from context; otherwise resolves it.
   */
  const requireFeature = (feature: string) => {
    return async (c: Context, next: Next) => {
      let tier = c.get("tier") as PlanTier | undefined;

      if (!tier) {
        const user = c.get(userKey) as Record<string, unknown> | undefined;
        if (!user) {
          return c.json({ error: "Authentication required" }, 401);
        }
        const userId = user[userIdField] as string | undefined;
        if (!userId) {
          return c.json({ error: "Authentication required" }, 401);
        }
        tier = await cfg.getUserTier(userId);
        c.set("tier", tier);
      }

      if (!tier.features.includes(feature)) {
        return c.json(
          {
            error: "Feature not available on your plan",
            feature,
            current: tier.name,
            upgradeUrl: "/settings/billing",
          },
          403,
        );
      }

      return next();
    };
  };

  /**
   * Check whether a plugin's tier requirement is satisfied by the user's plan.
   * Defaults to "free" when the manifest omits `tier`.
   */
  const checkPluginAccess = (pluginTier: "free" | "premium" | undefined, userTier: PlanTier): boolean => {
    if (!pluginTier || pluginTier === "free") return true;
    // premium plugins require the premium_plugins feature flag
    return userTier.features.includes("premium_plugins");
  };

  return { requireTier, requireFeature, checkPluginAccess };
}
