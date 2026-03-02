import { describe, expect, it } from "vitest";
import { type HealthProbeDeps, probePaymentHealth } from "./health-probe.js";

function makeDeps(overrides: Partial<HealthProbeDeps> = {}): HealthProbeDeps {
  return {
    stripe: {
      balance: {
        retrieve: async () => ({ available: [] }),
      },
    } as unknown as HealthProbeDeps["stripe"],
    alertChecker: {
      getStatus: () => [],
    } as unknown as HealthProbeDeps["alertChecker"],
    metrics: {
      getWindow: async () => ({
        totalRequests: 100,
        totalErrors: 0,
        errorRate: 0,
        creditDeductionFailures: 0,
        byCapability: new Map(),
      }),
    } as unknown as HealthProbeDeps["metrics"],
    ...overrides,
  };
}

describe("probePaymentHealth", () => {
  it("returns healthy when all systems OK", async () => {
    const result = await probePaymentHealth(makeDeps());
    expect(result.overall).toBe("healthy");
    expect(result.severity).toBeNull();
    expect(result.reasons).toHaveLength(0);
    expect(result.checks.stripeApi.ok).toBe(true);
    expect(result.checks.stripeApi.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checks.meterDlq.ok).toBe(true);
    expect(result.checks.meterDlq.depth).toBe(0);
    expect(result.checks.alerts.ok).toBe(true);
    expect(result.checks.alerts.firingCount).toBe(0);
  });

  it("returns outage when Stripe is unreachable", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        stripe: {
          balance: {
            retrieve: async () => {
              throw new Error("connect ECONNREFUSED");
            },
          },
        } as unknown as HealthProbeDeps["stripe"],
      }),
    );
    expect(result.overall).toBe("outage");
    expect(result.severity).toBe("SEV1");
    expect(result.checks.stripeApi.ok).toBe(false);
    expect(result.checks.stripeApi.error).toBe("connect ECONNREFUSED");
  });

  it("returns degraded when DLQ has items", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        dlq: { count: () => 5 } as unknown as HealthProbeDeps["dlq"],
      }),
    );
    expect(result.overall).toBe("degraded");
    expect(result.severity).toBe("SEV3");
    expect(result.checks.meterDlq.ok).toBe(false);
    expect(result.checks.meterDlq.depth).toBe(5);
  });

  it("returns degraded when gateway error rate is high (SEV2 range)", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        metrics: {
          getWindow: async () => ({
            totalRequests: 100,
            totalErrors: 15,
            errorRate: 0.15,
            creditDeductionFailures: 0,
            byCapability: new Map(),
          }),
        } as unknown as HealthProbeDeps["metrics"],
      }),
    );
    expect(result.overall).toBe("degraded");
    expect(result.severity).toBe("SEV2");
    expect(result.checks.gatewayMetrics.ok).toBe(false);
    expect(result.checks.gatewayMetrics.errorRate).toBe(0.15);
  });

  it("returns outage with firing alerts (SEV1 at >= 3)", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        alertChecker: {
          getStatus: () => [
            { name: "alert-1", firing: true, message: "a" },
            { name: "alert-2", firing: true, message: "b" },
            { name: "alert-3", firing: true, message: "c" },
          ],
        } as unknown as HealthProbeDeps["alertChecker"],
      }),
    );
    expect(result.overall).toBe("outage");
    expect(result.severity).toBe("SEV1");
    expect(result.checks.alerts.ok).toBe(false);
    expect(result.checks.alerts.firingCount).toBe(3);
    expect(result.checks.alerts.firingNames).toEqual(["alert-1", "alert-2", "alert-3"]);
  });

  it("handles webhook freshness check when queryLastWebhookAgeMs provided", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        queryLastWebhookAgeMs: () => 1000, // 1 second — fresh
      }),
    );
    expect(result.overall).toBe("healthy");
    expect(result.checks.webhookFreshness.ok).toBe(true);
    expect(result.checks.webhookFreshness.lastEventAgeMs).toBe(1000);
  });

  it("returns outage when webhook age exceeds 30 minute threshold", async () => {
    const staleAgeMs = 31 * 60 * 1000; // 31 minutes
    const result = await probePaymentHealth(
      makeDeps({
        queryLastWebhookAgeMs: () => staleAgeMs,
      }),
    );
    expect(result.overall).toBe("outage");
    expect(result.severity).toBe("SEV1");
    expect(result.checks.webhookFreshness.ok).toBe(false);
  });

  it("returns outage when queryLastWebhookAgeMs returns null (no events ever)", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        queryLastWebhookAgeMs: () => null,
      }),
    );
    // null age means webhooksOk = false (null is not <= threshold)
    expect(result.overall).toBe("outage");
    expect(result.severity).toBe("SEV1");
  });

  it("skips webhook check when queryLastWebhookAgeMs not provided", async () => {
    const result = await probePaymentHealth(makeDeps());
    // webhooksOk stays null -> webhooksReceiving: null -> skipped in severity
    expect(result.checks.webhookFreshness.ok).toBe(true); // default when dep not configured
    expect(result.checks.webhookFreshness.lastEventAgeMs).toBeNull();
  });

  it("handles negative balance tenants via queryNegativeBalanceTenants", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        queryNegativeBalanceTenants: () => 10,
      }),
    );
    expect(result.overall).toBe("degraded");
    expect(result.severity).toBe("SEV3");
    expect(result.checks.creditLedger.ok).toBe(false);
    expect(result.checks.creditLedger.negativeBalanceTenants).toBe(10);
  });

  it("includes auto-topup failures in severity classification", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        queryAutoTopupFailures: async () => 3,
      }),
    );
    expect(result.overall).toBe("degraded");
    expect(result.severity).toBe("SEV2");
  });

  it("has a numeric timestamp", async () => {
    const before = Date.now();
    const result = await probePaymentHealth(makeDeps());
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});
