import { Hono } from "hono";
import type { AlertChecker } from "./alerts.js";
import type { MetricsCollector } from "./metrics.js";

export interface AdminHealthDeps {
  metrics: MetricsCollector;
  alertChecker: AlertChecker;
  /** Query active bot instances count. Should not throw (caller wraps). */
  queryActiveBots: () => number;
  /** Query total credits consumed in last 24 hours (cents). Should not throw (caller wraps). */
  queryCreditsConsumed24h: () => number;
}

/**
 * Create the admin health dashboard handler.
 * Returns a Hono app mountable at /admin/health.
 */
export function createAdminHealthHandler(deps: AdminHealthDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const last5m = deps.metrics.getWindow(5);
    const last60m = deps.metrics.getWindow(60);

    // Safely query fleet data
    let activeBots: number | null = null;
    try {
      activeBots = deps.queryActiveBots();
    } catch {
      // DB unavailable — return null
    }

    // Safely query billing data
    let creditsConsumed24h: number | null = null;
    try {
      creditsConsumed24h = deps.queryCreditsConsumed24h();
    } catch {
      // DB unavailable — return null
    }

    // Read last-computed alert statuses (read-only — no state mutation)
    const alertStatuses = deps.alertChecker.getStatus();

    return c.json({
      timestamp: Date.now(),
      gateway: {
        last5m: {
          totalRequests: last5m.totalRequests,
          totalErrors: last5m.totalErrors,
          errorRate: last5m.errorRate,
          byCapability: Object.fromEntries(last5m.byCapability),
        },
        last60m: {
          totalRequests: last60m.totalRequests,
          totalErrors: last60m.totalErrors,
          errorRate: last60m.errorRate,
        },
      },
      fleet: {
        activeBots,
      },
      billing: {
        creditsConsumed24h,
      },
      alerts: alertStatuses,
    });
  });

  return app;
}
