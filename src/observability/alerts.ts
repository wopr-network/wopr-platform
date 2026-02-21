import { logger } from "../config/logger.js";
import type { MetricsCollector } from "./metrics.js";
import { captureError } from "./sentry.js";

export interface AlertDefinition {
  name: string;
  description: string;
  /** Check function — returns an alert message if triggered, null otherwise. */
  check: () => string | null;
}

export interface AlertConfig {
  /** Gateway capability error rate threshold (percentage, default 5). */
  capabilityErrorRateThreshold?: number;
  /** Window in minutes for error rate calculation (default 5). */
  errorRateWindowMinutes?: number;
  /** Credit deduction failure spike threshold (count in 5 min, default 10). */
  creditFailureSpikeThreshold?: number;
  /** Webhook URL for alert notifications (optional). */
  webhookUrl?: string;
}

/**
 * Build the 3 required business metric alert definitions.
 * Each alert is self-contained and stateless (reads from MetricsCollector).
 */
export function buildAlerts(metrics: MetricsCollector, config: AlertConfig = {}): AlertDefinition[] {
  const errorRateThreshold = config.capabilityErrorRateThreshold ?? 5;
  const windowMinutes = config.errorRateWindowMinutes ?? 5;
  const creditFailureThreshold = config.creditFailureSpikeThreshold ?? 10;

  return [
    {
      name: "gateway-capability-error-rate",
      description: `Alert when any capability error rate exceeds ${errorRateThreshold}% in ${windowMinutes}-minute window`,
      check: () => {
        const window = metrics.getWindow(windowMinutes);
        for (const [capability, rate] of Object.entries(window.capabilityErrorRates)) {
          if (rate > errorRateThreshold) {
            return `Capability "${capability}" error rate ${rate.toFixed(1)}% exceeds ${errorRateThreshold}% threshold (last ${windowMinutes} min)`;
          }
        }
        return null;
      },
    },
    {
      name: "credit-deduction-failure-spike",
      description: `Alert when credit deduction failures exceed ${creditFailureThreshold} in ${windowMinutes}-minute window`,
      check: () => {
        const window = metrics.getWindow(windowMinutes);
        if (window.creditDeductionFailures > creditFailureThreshold) {
          return `Credit deduction failures spiked: ${window.creditDeductionFailures} in last ${windowMinutes} min (threshold: ${creditFailureThreshold})`;
        }
        return null;
      },
    },
    {
      name: "fleet-unexpected-stop",
      description: "Alert when any org's entire bot fleet stops unexpectedly",
      check: () => {
        // This alert is event-driven, not polled. See fleetStopAlert() below.
        // The check() here always returns null — the actual alert fires via
        // onFleetStatusChange() registered on the HeartbeatWatchdog/FleetManager.
        return null;
      },
    },
  ];
}

/** Interval-based alert checker. Runs every 60s. */
export class AlertChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly alerts: AlertDefinition[];
  private readonly onAlert: (name: string, message: string) => void;
  /** Track fired alerts to avoid repeated notifications. Resets after clear. */
  private firedAlerts = new Set<string>();

  constructor(alerts: AlertDefinition[], onAlert: (name: string, message: string) => void) {
    this.alerts = alerts;
    this.onAlert = onAlert;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runChecks(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runChecks(): void {
    for (const alert of this.alerts) {
      const message = alert.check();
      if (message && !this.firedAlerts.has(alert.name)) {
        this.firedAlerts.add(alert.name);
        this.onAlert(alert.name, message);
        logger.error(`ALERT [${alert.name}]: ${message}`);
        captureError(new Error(`Alert: ${message}`), {
          extra: { alertName: alert.name },
        });
      } else if (!message) {
        // Alert cleared — allow re-firing
        this.firedAlerts.delete(alert.name);
      }
    }
  }
}

/**
 * Fire an event-driven alert when a tenant's entire fleet stops unexpectedly.
 * Call this from the HeartbeatWatchdog or FleetManager when a fleet-wide stop
 * is detected.
 */
export function fleetStopAlert(
  tenantId: string,
  botCount: number,
  onAlert: (name: string, message: string) => void,
): void {
  const message = `Org ${tenantId}'s entire fleet (${botCount} bots) stopped unexpectedly`;
  onAlert("fleet-unexpected-stop", message);
  logger.error(`ALERT [fleet-unexpected-stop]: ${message}`);
  captureError(new Error(`Fleet stop: ${message}`), {
    orgId: tenantId,
    extra: { botCount },
  });
}
