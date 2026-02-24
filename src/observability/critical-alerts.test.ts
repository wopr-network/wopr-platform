import { describe, expect, it, vi } from "vitest";
import { buildCriticalAlerts } from "./critical-alerts.js";

function makeStubMetrics(
  overrides: Partial<{
    errorRate: number;
    totalRequests: number;
    creditDeductionFailures: number;
  }> = {},
) {
  return {
    getWindow: vi.fn().mockReturnValue({
      totalRequests: overrides.totalRequests ?? 0,
      totalErrors: 0,
      errorRate: overrides.errorRate ?? 0,
      creditDeductionFailures: overrides.creditDeductionFailures ?? 0,
      byCapability: new Map(),
    }),
  };
}

describe("buildCriticalAlerts", () => {
  it("returns 5 critical alert definitions", () => {
    const alerts = buildCriticalAlerts({
      metrics: makeStubMetrics() as never,
      dbHealthCheck: () => true,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });
    expect(alerts).toHaveLength(5);
    expect(alerts.map((a) => a.name)).toEqual([
      "sev1-billing-pipeline",
      "sev1-payment-processing",
      "sev1-auth-failure",
      "sev1-database-unavailable",
      "sev1-inference-gateway-down",
    ]);
  });

  it("sev1-billing-pipeline fires when credit failures > 20 in 5min", () => {
    const alerts = buildCriticalAlerts({
      metrics: makeStubMetrics({ creditDeductionFailures: 25 }) as never,
      dbHealthCheck: () => true,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });
    const result = alerts.find((a) => a.name === "sev1-billing-pipeline")!.check();
    expect(result.firing).toBe(true);
  });

  it("sev1-database-unavailable fires when dbHealthCheck returns false", () => {
    const alerts = buildCriticalAlerts({
      metrics: makeStubMetrics() as never,
      dbHealthCheck: () => false,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });
    const result = alerts.find((a) => a.name === "sev1-database-unavailable")!.check();
    expect(result.firing).toBe(true);
  });

  it("sev1-auth-failure fires when authHealthCheck returns false", () => {
    const alerts = buildCriticalAlerts({
      metrics: makeStubMetrics() as never,
      dbHealthCheck: () => true,
      authHealthCheck: () => false,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });
    const result = alerts.find((a) => a.name === "sev1-auth-failure")!.check();
    expect(result.firing).toBe(true);
  });

  it("sev1-inference-gateway-down fires when gateway is unhealthy", () => {
    const alerts = buildCriticalAlerts({
      metrics: makeStubMetrics() as never,
      dbHealthCheck: () => true,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: false, latencyMs: 30000 }),
    });
    const result = alerts.find((a) => a.name === "sev1-inference-gateway-down")!.check();
    expect(result.firing).toBe(true);
  });

  it("sev1-payment-processing fires when error rate > 10% with high traffic", () => {
    const alerts = buildCriticalAlerts({
      metrics: makeStubMetrics({ errorRate: 0.15, totalRequests: 100 }) as never,
      dbHealthCheck: () => true,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });
    const result = alerts.find((a) => a.name === "sev1-payment-processing")!.check();
    expect(result.firing).toBe(true);
  });

  it("no alerts fire when everything is healthy", () => {
    const alerts = buildCriticalAlerts({
      metrics: makeStubMetrics({ totalRequests: 100 }) as never,
      dbHealthCheck: () => true,
      authHealthCheck: () => true,
      gatewayHealthCheck: () => ({ healthy: true, latencyMs: 50 }),
    });
    for (const alert of alerts) {
      expect(alert.check().firing).toBe(false);
    }
  });
});
