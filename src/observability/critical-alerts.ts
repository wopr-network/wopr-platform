import type { AlertDefinition } from "./alerts.js";
import type { MetricsCollector } from "./metrics.js";

export interface CriticalAlertDeps {
  metrics: MetricsCollector;
  /** Returns true if the database is reachable. */
  dbHealthCheck: () => boolean;
  /** Returns true if auth service is functional. */
  authHealthCheck: () => boolean;
  /** Returns gateway health status. */
  gatewayHealthCheck: () => { healthy: boolean; latencyMs: number };
}

/**
 * Build SEV1 critical alert definitions for the 5 key domains:
 * 1. Billing pipeline (credit deduction failures)
 * 2. Payment processing (high error rate on gateway calls)
 * 3. Auth failures (auth service down)
 * 4. Database unavailable
 * 5. Inference gateway down
 */
export function buildCriticalAlerts(deps: CriticalAlertDeps): AlertDefinition[] {
  return [
    {
      name: "sev1-billing-pipeline",
      check: () => {
        const window = deps.metrics.getWindow(5);
        const failures = window.creditDeductionFailures;
        const threshold = 20;
        const firing = failures > threshold;
        return {
          firing,
          value: failures,
          threshold,
          message: firing
            ? `CRITICAL: ${failures} credit deduction failures in 5min (threshold: ${threshold})`
            : `Billing pipeline healthy: ${failures} failures in 5min`,
        };
      },
    },
    {
      name: "sev1-payment-processing",
      check: () => {
        const window = deps.metrics.getWindow(5);
        const threshold = 0.1;
        const firing = window.totalRequests > 0 && window.errorRate > threshold;
        return {
          firing,
          value: window.errorRate,
          threshold,
          message: firing
            ? `CRITICAL: Payment processing error rate ${(window.errorRate * 100).toFixed(1)}% (threshold: ${threshold * 100}%)`
            : `Payment processing healthy: ${(window.errorRate * 100).toFixed(1)}% error rate`,
        };
      },
    },
    {
      name: "sev1-auth-failure",
      check: () => {
        const healthy = deps.authHealthCheck();
        return {
          firing: !healthy,
          value: healthy ? 0 : 1,
          threshold: 1,
          message: healthy ? "Auth service healthy" : "CRITICAL: Auth service unreachable",
        };
      },
    },
    {
      name: "sev1-database-unavailable",
      check: () => {
        const healthy = deps.dbHealthCheck();
        return {
          firing: !healthy,
          value: healthy ? 0 : 1,
          threshold: 1,
          message: healthy ? "Database healthy" : "CRITICAL: Database unreachable",
        };
      },
    },
    {
      name: "sev1-inference-gateway-down",
      check: () => {
        const status = deps.gatewayHealthCheck();
        return {
          firing: !status.healthy,
          value: status.latencyMs,
          threshold: 1,
          message: status.healthy
            ? `Inference gateway healthy (${status.latencyMs}ms)`
            : `CRITICAL: Inference gateway down (${status.latencyMs}ms)`,
        };
      },
    },
  ];
}
