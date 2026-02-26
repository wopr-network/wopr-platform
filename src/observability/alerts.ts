import { logger } from "../config/logger.js";
import type { IFleetEventRepository } from "../fleet/fleet-event-repository.js";
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
  check: () => AlertCheckResult | Promise<AlertCheckResult>;
}

/**
 * Build the 3 business metric alerts.
 *
 * 1. Gateway capability error rate > 5% in 5 minutes
 * 2. Credit deduction failures spike (> 10 in 5 minutes)
 * 3. Fleet unexpected stop (event-driven)
 */
export function buildAlerts(metrics: MetricsCollector, fleetEventRepo: IFleetEventRepository): AlertDefinition[] {
  return [
    {
      name: "gateway-error-rate",
      check: async () => {
        const window = await metrics.getWindow(5);
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
      check: async () => {
        const window = await metrics.getWindow(5);
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
      check: async () => {
        const firing = await fleetEventRepo.isFleetStopFired();
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
  private readonly fleetEventRepo: IFleetEventRepository | null;
  private readonly onFire: ((alertName: string, result: AlertCheckResult) => void) | null;
  private readonly onResolve: ((alertName: string, result: AlertCheckResult) => void) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly firedState: Map<string, boolean> = new Map();
  private lastResults: Array<{ name: string; firing: boolean; message: string }> = [];

  constructor(
    alerts: AlertDefinition[],
    opts?: {
      intervalMs?: number;
      fleetEventRepo?: IFleetEventRepository;
      onFire?: (alertName: string, result: AlertCheckResult) => void;
      onResolve?: (alertName: string, result: AlertCheckResult) => void;
    },
  ) {
    this.alerts = alerts;
    this.intervalMs = opts?.intervalMs ?? 60_000;
    this.fleetEventRepo = opts?.fleetEventRepo ?? null;
    this.onFire = opts?.onFire ?? null;
    this.onResolve = opts?.onResolve ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkAll();
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkAll(): Promise<Array<{ name: string; firing: boolean; message: string }>> {
    const results: Array<{ name: string; firing: boolean; message: string }> = [];

    for (const alert of this.alerts) {
      const result = await alert.check();
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
        this.onFire?.(alert.name, result);
      } else if (!result.firing && wasFiring) {
        // Transition: firing -> resolved
        logger.info(`Alert RESOLVED: ${alert.name}`, { message: result.message });
        this.firedState.set(alert.name, false);
        this.onResolve?.(alert.name, result);
      }

      results.push({ name: alert.name, firing: result.firing, message: result.message });
    }

    // Clear the event-driven fleet stop flag after processing
    if (await this.fleetEventRepo?.isFleetStopFired()) {
      await this.fleetEventRepo?.clearFleetStop();
    }

    this.lastResults = results;
    return results;
  }

  /**
   * Return the last-computed alert statuses. Read-only — does not invoke
   * alert check functions, mutate deduplication state, or clear event flags.
   * Returns an empty array if checkAll() has never been called.
   */
  getStatus(): Array<{ name: string; firing: boolean; message: string }> {
    return this.lastResults;
  }
}
