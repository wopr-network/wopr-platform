export type Severity = "SEV1" | "SEV2" | "SEV3";

export interface SeveritySignals {
  /** Stripe API reachable? */
  stripeReachable: boolean;
  /** Webhook events received in last 30 minutes? */
  webhooksReceiving: boolean;
  /** Gateway error rate (0-1) from MetricsCollector 5min window. */
  gatewayErrorRate: number;
  /** Credit deduction failures in 5min window. */
  creditDeductionFailures: number;
  /** Number of events in the meter DLQ. */
  dlqDepth: number;
  /** Number of tenants with negative balance (from ledger scan). */
  tenantsWithNegativeBalance: number;
  /** Auto-topup consecutive failure count (from event log). */
  autoTopupFailures: number;
  /** Number of alerts currently firing. */
  firingAlertCount: number;
}

/**
 * Classify incident severity based on observable payment system signals.
 *
 * SEV1: Total payment outage — no money flowing
 *   - Stripe unreachable OR webhooks stopped OR gateway error rate > 50%
 * SEV2: Degraded — payments partially broken
 *   - Credit deduction failures > 10 OR DLQ depth > 50 OR auto-topup failures >= 3
 *   - Gateway error rate 5–50%
 * SEV3: Warning — early signals
 *   - DLQ depth > 0 OR credit deduction failures > 0 OR gateway error rate > 2%
 *   - Negative-balance tenants > 5
 */
export function classifySeverity(signals: SeveritySignals): { severity: Severity; reasons: string[] } {
  const reasons: string[] = [];

  // SEV1 conditions
  if (!signals.stripeReachable) {
    reasons.push("Stripe API unreachable");
  }
  if (!signals.webhooksReceiving) {
    reasons.push("No webhook events received in last 30 minutes");
  }
  if (signals.gatewayErrorRate > 0.5) {
    reasons.push(`Gateway error rate ${(signals.gatewayErrorRate * 100).toFixed(1)}% exceeds 50% threshold`);
  }

  if (reasons.length > 0) {
    return { severity: "SEV1", reasons };
  }

  // SEV2 conditions
  if (signals.creditDeductionFailures > 10) {
    reasons.push(`Credit deduction failures (${signals.creditDeductionFailures}) exceeds threshold of 10`);
  }
  if (signals.dlqDepth > 50) {
    reasons.push(`Meter DLQ depth (${signals.dlqDepth}) exceeds threshold of 50`);
  }
  if (signals.autoTopupFailures >= 3) {
    reasons.push(`Auto-topup consecutive failures (${signals.autoTopupFailures}) reached threshold of 3`);
  }
  if (signals.gatewayErrorRate > 0.05 && signals.gatewayErrorRate <= 0.5) {
    reasons.push(`Gateway error rate ${(signals.gatewayErrorRate * 100).toFixed(1)}% in degraded range (5–50%)`);
  }

  if (reasons.length > 0) {
    return { severity: "SEV2", reasons };
  }

  // SEV3 conditions
  if (signals.dlqDepth > 0) {
    reasons.push(`Meter DLQ has ${signals.dlqDepth} pending event(s)`);
  }
  if (signals.creditDeductionFailures > 0) {
    reasons.push(`${signals.creditDeductionFailures} credit deduction failure(s) in 5min window`);
  }
  if (signals.gatewayErrorRate > 0.02) {
    reasons.push(`Gateway error rate ${(signals.gatewayErrorRate * 100).toFixed(1)}% above 2% warning threshold`);
  }
  if (signals.tenantsWithNegativeBalance > 5) {
    reasons.push(`${signals.tenantsWithNegativeBalance} tenants with negative balance`);
  }

  if (reasons.length > 0) {
    return { severity: "SEV3", reasons };
  }

  // No issues — return SEV3 with no reasons (caller should check reasons.length)
  return { severity: "SEV3", reasons: [] };
}
