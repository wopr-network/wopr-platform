import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChecker, buildAlerts } from "./alerts.js";
import { createAdminHealthHandler } from "./health-dashboard.js";
import { MetricsCollector } from "./metrics.js";

describe("admin health dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
  });

  it("returns JSON with gateway, fleet, billing, and alerts sections", async () => {
    const metrics = new MetricsCollector();
    metrics.recordGatewayRequest("chat-completions");
    metrics.recordGatewayRequest("chat-completions");
    metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics);
    const checker = new AlertChecker(alerts);

    const handler = createAdminHealthHandler({
      metrics,
      alertChecker: checker,
      queryActiveBots: () => 5,
      queryCreditsConsumed24h: () => 1234,
    });

    const res = await handler.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("gateway");
    expect(body).toHaveProperty("fleet");
    expect(body).toHaveProperty("billing");
    expect(body).toHaveProperty("alerts");
    expect(body.gateway.last5m.totalRequests).toBe(2);
    expect(body.gateway.last5m.totalErrors).toBe(1);
    expect(body.fleet.activeBots).toBe(5);
    expect(body.billing.creditsConsumed24h).toBe(1234);
    expect(body.alerts).toHaveLength(3);
  });

  it("handles DB query failures gracefully", async () => {
    const metrics = new MetricsCollector();
    const alerts = buildAlerts(metrics);
    const checker = new AlertChecker(alerts);

    const handler = createAdminHealthHandler({
      metrics,
      alertChecker: checker,
      queryActiveBots: () => {
        throw new Error("DB locked");
      },
      queryCreditsConsumed24h: () => {
        throw new Error("DB locked");
      },
    });

    const res = await handler.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fleet.activeBots).toBeNull();
    expect(body.billing.creditsConsumed24h).toBeNull();
  });

  it("returns correct alert statuses", async () => {
    const metrics = new MetricsCollector();
    // Push error rate above 5%
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 10; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics);
    const checker = new AlertChecker(alerts);

    const handler = createAdminHealthHandler({
      metrics,
      alertChecker: checker,
      queryActiveBots: () => 0,
      queryCreditsConsumed24h: () => 0,
    });

    const res = await handler.request("/");
    const body = await res.json();
    const gatewayAlert = body.alerts.find((a: { name: string }) => a.name === "gateway-error-rate");
    expect(gatewayAlert.firing).toBe(true);
  });
});
