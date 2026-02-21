import { describe, expect, it, vi } from "vitest";
import { buildAlerts } from "./alerts.js";
import { adminHealthHandler } from "./health-dashboard.js";
import { MetricsCollector } from "./metrics.js";

function makeRequest() {
  return new Request("http://localhost/admin/health");
}

describe("adminHealthHandler", () => {
  it("returns 200 with correct JSON shape", async () => {
    const metrics = new MetricsCollector(60);
    const alerts = buildAlerts(metrics);
    const handler = adminHealthHandler({ metrics, alerts });

    const response = handler({} as Parameters<typeof handler>[0]);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("gateway");
    expect(body.gateway).toHaveProperty("last5m");
    expect(body.gateway).toHaveProperty("last60m");
    expect(body).toHaveProperty("fleet");
    expect(body).toHaveProperty("billing");
    expect(body).toHaveProperty("alerts");
  });

  it("gateway metrics section reflects MetricsCollector state", async () => {
    const metrics = new MetricsCollector(60);
    metrics.recordGatewayRequest("llm");
    metrics.recordGatewayRequest("llm");
    metrics.recordGatewayError("llm");

    const alerts = buildAlerts(metrics);
    const handler = adminHealthHandler({ metrics, alerts });

    const response = handler({} as Parameters<typeof handler>[0]);
    const body = await response.json();

    expect(body.gateway.last5m.requests).toBe(2);
    expect(body.gateway.last5m.errors).toBe(1);
    expect(body.gateway.last5m.errorRate).toBe("50.0%");
  });

  it("alert statuses are included", async () => {
    const metrics = new MetricsCollector(60);
    const alerts = buildAlerts(metrics);
    const handler = adminHealthHandler({ metrics, alerts });

    const response = handler({} as Parameters<typeof handler>[0]);
    const body = await response.json();

    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.alerts).toHaveLength(3);
    expect(body.alerts[0]).toHaveProperty("name");
    expect(body.alerts[0]).toHaveProperty("triggered");
  });

  it("active bot count query works with mock DB", async () => {
    const metrics = new MetricsCollector(60);
    const alerts = buildAlerts(metrics);

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ count: 42 }),
      }),
    };

    const handler = adminHealthHandler({
      metrics,
      alerts,
      billingDb: mockDb as unknown as import("better-sqlite3").Database,
    });

    const response = handler({} as Parameters<typeof handler>[0]);
    const body = await response.json();

    expect(body.fleet.activeBotInstances).toBe(42);
  });

  it("credits consumed 24h query works with mock DB", async () => {
    const metrics = new MetricsCollector(60);
    const alerts = buildAlerts(metrics);

    // Mock DB that returns different values per prepare call
    let callCount = 0;
    const mockDb = {
      prepare: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: bot_instances count
          return { get: vi.fn().mockReturnValue({ count: 0 }) };
        }
        // Second call: meter_events sum
        return { get: vi.fn().mockReturnValue({ total_cents: 5000 }) };
      }),
    };

    const handler = adminHealthHandler({
      metrics,
      alerts,
      billingDb: mockDb as unknown as import("better-sqlite3").Database,
    });

    const response = handler({} as Parameters<typeof handler>[0]);
    const body = await response.json();

    expect(body.billing.creditsConsumed24hCents).toBe(5000);
  });

  it("works without billingDb (returns zeros)", async () => {
    const metrics = new MetricsCollector(60);
    const alerts = buildAlerts(metrics);
    const handler = adminHealthHandler({ metrics, alerts });

    const response = handler({} as Parameters<typeof handler>[0]);
    const body = await response.json();

    expect(body.fleet.activeBotInstances).toBe(0);
    expect(body.billing.creditsConsumed24hCents).toBe(0);
  });

  it("content-type is application/json", () => {
    const metrics = new MetricsCollector(60);
    const alerts = buildAlerts(metrics);
    const handler = adminHealthHandler({ metrics, alerts });
    const response = handler({} as Parameters<typeof handler>[0]);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// Keep the request factory available if needed in the future
void makeRequest;
