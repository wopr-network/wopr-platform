import { describe, expect, it } from "vitest";
import { probePaymentHealth, type HealthProbeDeps } from "../../../src/monetization/incident/health-probe.js";

function makeDeps(overrides?: Partial<HealthProbeDeps>): HealthProbeDeps {
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
      getWindow: () => ({
        totalRequests: 100,
        totalErrors: 0,
        errorRate: 0,
        creditDeductionFailures: 0,
        byCapability: new Map(),
      }),
    } as unknown as HealthProbeDeps["metrics"],
    dlq: { count: () => 0 } as unknown as HealthProbeDeps["dlq"],
    queryNegativeBalanceTenants: () => 0,
    queryLastWebhookAgeMs: () => 5000,
    ...overrides,
  };
}

describe("probePaymentHealth", () => {
  it("returns healthy when all checks pass", async () => {
    const result = await probePaymentHealth(makeDeps());
    expect(result.overall).toBe("healthy");
    expect(result.severity).toBeNull();
    expect(result.checks.stripeApi.ok).toBe(true);
  });

  it("returns outage when Stripe API fails", async () => {
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
  });

  it("returns degraded when DLQ has items", async () => {
    const result = await probePaymentHealth(
      makeDeps({ dlq: { count: () => 5 } as unknown as HealthProbeDeps["dlq"] }),
    );
    expect(result.overall).toBe("degraded");
    expect(result.checks.meterDlq.ok).toBe(false);
    expect(result.checks.meterDlq.depth).toBe(5);
  });

  it("returns degraded when webhooks are stale (> 30 min)", async () => {
    const result = await probePaymentHealth(
      makeDeps({ queryLastWebhookAgeMs: () => 35 * 60 * 1000 }),
    );
    expect(result.checks.webhookFreshness.ok).toBe(false);
  });

  it("handles missing optional deps gracefully", async () => {
    const result = await probePaymentHealth(
      makeDeps({ dlq: undefined, queryNegativeBalanceTenants: undefined, queryLastWebhookAgeMs: undefined }),
    );
    expect(result.overall).toBe("healthy");
  });

  it("includes firing alert names", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        alertChecker: {
          getStatus: () => [
            { name: "credit-deduction-spike", firing: true, message: "15 failures" },
            { name: "gateway-error-rate", firing: false, message: "ok" },
          ],
        } as unknown as HealthProbeDeps["alertChecker"],
      }),
    );
    expect(result.checks.alerts.firingNames).toContain("credit-deduction-spike");
    expect(result.checks.alerts.firingCount).toBe(1);
  });

  it("includes stripe error message on failure", async () => {
    const result = await probePaymentHealth(
      makeDeps({
        stripe: {
          balance: {
            retrieve: async () => {
              throw new Error("Unauthorized");
            },
          },
        } as unknown as HealthProbeDeps["stripe"],
      }),
    );
    expect(result.checks.stripeApi.error).toContain("Unauthorized");
  });

  it("has a timestamp", async () => {
    const before = Date.now();
    const result = await probePaymentHealth(makeDeps());
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
  });
});
