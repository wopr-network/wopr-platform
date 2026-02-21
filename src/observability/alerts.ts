import { logger } from "../config/logger.js";
import type { MetricsCollector } from "./metrics.js";
import { captureMessage } from "./sentry.js";

export interface AlertCheckResult {
  firing: boolean;
  value: number;
  threshold: number;
  message: string;
}

export interface AlertDefinition {
  name: string;
  check: () => AlertCheckResult;
}

/** Track fleet-unexpected-stop events externally. */
let fleetStopFired = false;

/** Call this from the fleet event handler when bots stop unexpectedly. */
export function fleetStopAlert(): void {
  fleetStopFired = true;
}

/** Reset the fleet stop flag (called by AlertChecker after processing). */
export function clearFleetStopAlert(): void {
  fleetStopFired = false;
}

/**
 * Build the 3 business metric alerts.
 *
 * 1. Gateway capability error rate > 5% in 5 minutes
 * 2. Credit deduction failures spike (> 10 in 5 minutes)
 * 3. Fleet unexpected stop (event-driven)
 */
export function buildAlerts(metrics: MetricsCollector): AlertDefinition[] {
  return [
    {
      name: "gateway-error-rate",
      check: () => {
        const window = metrics.getWindow(5);
        const errorRate = window.errorRate;
        const threshold = 0.05;
        return {
          firing: window.totalRequests > 0 && errorRate > threshold,
          value: errorRate,
          threshold,
          message:
            window.totalRequests > 0 && errorRate > threshold
              ? `Gateway error rate ${(errorRate * 100).toFixed(1)}% exceeds ${threshold * 100}% threshold (${window.totalErrors}/${window.totalRequests} requests in 5min)`
              : `Gateway error rate ${(errorRate * 100).toFixed(1)}% within threshold`,
        };
      },
    },
    {
      name: "credit-deduction-spike",
      check: () => {
        const window = metrics.getWindow(5);
        const failures = window.creditDeductionFailures;
        const threshold = 10;
        return {
          firing: failures > threshold,
          value: failures,
          threshold,
          message:
            failures > threshold
              ? `${failures} credit deduction failures in 5min exceeds threshold of ${threshold}`
              : `${failures} credit deduction failures in 5min within threshold`,
        };
      },
    },
    {
      name: "fleet-unexpected-stop",
      check: () => {
        const firing = fleetStopFired;
        return {
          firing,
          value: firing ? 1 : 0,
          threshold: 1,
          message: firing ? "Fleet bots stopped unexpectedly" : "Fleet operating normally",
        };
      },
    },
  ];
}

/**
 * Periodically checks all alert definitions, deduplicates firings,
 * and logs/captures to Sentry on state transitions.
 */
export class AlertChecker {
  private readonly alerts: AlertDefinition[];
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly firedState: Map<string, boolean> = new Map();

  constructor(alerts: AlertDefinition[], opts?: { intervalMs?: number }) {
    this.alerts = alerts;
    this.intervalMs = opts?.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkAll(): Array<{ name: string; firing: boolean; message: string }> {
    const results: Array<{ name: string; firing: boolean; message: string }> = [];

    for (const alert of this.alerts) {
      const result = alert.check();
      const wasFiring = this.firedState.get(alert.name) ?? false;

      if (result.firing && !wasFiring) {
        // Transition: not-firing -> firing
        logger.warn(`Alert FIRING: ${alert.name}`, {
          message: result.message,
          value: result.value,
          threshold: result.threshold,
        });
        captureMessage(`Alert: ${alert.name} — ${result.message}`, "warning");
        this.firedState.set(alert.name, true);
      } else if (!result.firing && wasFiring) {
        // Transition: firing -> resolved
        logger.info(`Alert RESOLVED: ${alert.name}`, { message: result.message });
        this.firedState.set(alert.name, false);
      }

      results.push({ name: alert.name, firing: result.firing, message: result.message });
    }

    // Clear the event-driven fleet stop flag after processing
    if (fleetStopFired) {
      clearFleetStopAlert();
    }

    return results;
  }
}
