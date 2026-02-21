import type Database from "better-sqlite3";
import type { Context } from "hono";
import type { AlertDefinition } from "./alerts.js";
import type { MetricsCollector } from "./metrics.js";

export interface HealthDashboardDeps {
  metrics: MetricsCollector;
  alerts: AlertDefinition[];
  billingDb?: Database.Database;
}

/**
 * GET /admin/health handler — returns operational health dashboard data.
 *
 * Response includes:
 * - Gateway request rate + error rate (last 5 min, last 60 min)
 * - Active bot instance count
 * - Credits consumed in last 24h
 * - Current alert statuses
 */
export function adminHealthHandler(deps: HealthDashboardDeps) {
  return (_c: Context): Response => {
    const last5m = deps.metrics.getWindow(5);
    const last60m = deps.metrics.getWindow(60);

    // Active bot instances
    let activeBotCount = 0;
    if (deps.billingDb) {
      const row = deps.billingDb
        .prepare(`SELECT COUNT(*) as count FROM bot_instances WHERE billing_state = 'active'`)
        .get() as { count: number } | undefined;
      activeBotCount = row?.count ?? 0;
    }

    // Credits consumed in last 24h
    let creditsConsumed24h = 0;
    if (deps.billingDb) {
      const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
      const row = deps.billingDb
        .prepare(
          `SELECT COALESCE(CAST(SUM(charge) * 100 AS INTEGER), 0) as total_cents
           FROM meter_events
           WHERE timestamp >= ?`,
        )
        .get(twentyFourHoursAgo) as { total_cents: number } | undefined;
      creditsConsumed24h = row?.total_cents ?? 0;
    }

    // Alert statuses
    const alertStatuses = deps.alerts.map((alert) => {
      const result = alert.check();
      return {
        name: alert.name,
        description: alert.description,
        status: result ?? "ok",
        triggered: result !== null,
      };
    });

    const response = {
      timestamp: Date.now(),
      gateway: {
        last5m: {
          requests: last5m.totalRequests,
          errors: last5m.totalErrors,
          errorRate: `${last5m.errorRate.toFixed(1)}%`,
          capabilityErrorRates: last5m.capabilityErrorRates,
          creditDeductionFailures: last5m.creditDeductionFailures,
        },
        last60m: {
          requests: last60m.totalRequests,
          errors: last60m.totalErrors,
          errorRate: `${last60m.errorRate.toFixed(1)}%`,
        },
      },
      fleet: {
        activeBotInstances: activeBotCount,
      },
      billing: {
        creditsConsumed24hCents: creditsConsumed24h,
      },
      alerts: alertStatuses,
    };

    return new Response(JSON.stringify(response, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
