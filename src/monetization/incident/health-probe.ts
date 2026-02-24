import type { AlertChecker } from "../../observability/alerts.js";
import type { MetricsCollector } from "../../observability/metrics.js";
import type { MeterDLQ } from "../metering/dlq.js";
import type { Severity } from "./severity.js";
import { classifySeverity } from "./severity.js";

export interface PaymentHealthStatus {
  timestamp: number;
  overall: "healthy" | "degraded" | "outage";
  severity: Severity | null; // null = healthy
  checks: {
    stripeApi: { ok: boolean; latencyMs: number | null; error?: string };
    webhookFreshness: { ok: boolean; lastEventAgeMs: number | null };
    creditLedger: { ok: boolean; negativeBalanceTenants: number };
    meterDlq: { ok: boolean; depth: number };
    gatewayMetrics: { ok: boolean; errorRate: number; creditFailures: number };
    alerts: { ok: boolean; firingCount: number; firingNames: string[] };
  };
  reasons: string[];
}

export interface HealthProbeDeps {
  stripe: import("stripe").default;
  alertChecker: AlertChecker;
  metrics: MetricsCollector;
  dlq?: MeterDLQ;
  /** Query count of tenants with negative credit balance. */
  queryNegativeBalanceTenants?: () => number;
  /** Query age of most recent webhook event in ms. */
  queryLastWebhookAgeMs?: () => number | null;
}

const WEBHOOK_FRESHNESS_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export async function probePaymentHealth(deps: HealthProbeDeps): Promise<PaymentHealthStatus> {
  const timestamp = Date.now();

  // 1. Stripe API connectivity
  let stripeOk = false;
  let stripeLatencyMs: number | null = null;
  let stripeError: string | undefined;
  try {
    const start = Date.now();
    await deps.stripe.balance.retrieve();
    stripeLatencyMs = Date.now() - start;
    stripeOk = true;
  } catch (err) {
    stripeError = err instanceof Error ? err.message : String(err);
  }

  // 2. Webhook freshness
  let lastEventAgeMs: number | null = null;
  let webhooksOk = true;
  if (deps.queryLastWebhookAgeMs) {
    lastEventAgeMs = deps.queryLastWebhookAgeMs();
    if (lastEventAgeMs === null || lastEventAgeMs > WEBHOOK_FRESHNESS_THRESHOLD_MS) {
      webhooksOk = false;
    }
  }

  // 3. Credit ledger
  let negativeBalanceTenants = 0;
  if (deps.queryNegativeBalanceTenants) {
    try {
      negativeBalanceTenants = deps.queryNegativeBalanceTenants();
    } catch {
      // non-critical
    }
  }

  // 4. Meter DLQ
  const dlqDepth = deps.dlq ? deps.dlq.count() : 0;
  const dlqOk = dlqDepth === 0;

  // 5. Gateway metrics
  const window5m = deps.metrics.getWindow(5);
  const errorRate = window5m.errorRate;
  const creditFailures = window5m.creditDeductionFailures;
  const gatewayOk = errorRate <= 0.05 && creditFailures <= 10;

  // 6. Alerts
  const alertStatuses = deps.alertChecker.getStatus();
  const firingAlerts = alertStatuses.filter((a) => a.firing);
  const firingCount = firingAlerts.length;
  const firingNames = firingAlerts.map((a) => a.name);
  const alertsOk = firingCount === 0;

  const checks: PaymentHealthStatus["checks"] = {
    stripeApi: { ok: stripeOk, latencyMs: stripeLatencyMs, ...(stripeError ? { error: stripeError } : {}) },
    webhookFreshness: { ok: webhooksOk, lastEventAgeMs },
    creditLedger: { ok: negativeBalanceTenants === 0, negativeBalanceTenants },
    meterDlq: { ok: dlqOk, depth: dlqDepth },
    gatewayMetrics: { ok: gatewayOk, errorRate, creditFailures },
    alerts: { ok: alertsOk, firingCount, firingNames },
  };

  // Classify severity
  const { severity, reasons } = classifySeverity({
    stripeReachable: stripeOk,
    webhooksReceiving: webhooksOk,
    gatewayErrorRate: errorRate,
    creditDeductionFailures: creditFailures,
    dlqDepth,
    tenantsWithNegativeBalance: negativeBalanceTenants,
    autoTopupFailures: 0, // not available from deps without event log query
    firingAlertCount: firingCount,
  });

  let overall: PaymentHealthStatus["overall"];
  if (reasons.length === 0) {
    overall = "healthy";
  } else if (severity === "SEV1") {
    overall = "outage";
  } else {
    overall = "degraded";
  }

  return {
    timestamp,
    overall,
    severity: reasons.length > 0 ? severity : null,
    checks,
    reasons,
  };
}
