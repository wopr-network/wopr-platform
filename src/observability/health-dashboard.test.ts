import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleFleetEventRepository } from "../fleet/drizzle-fleet-event-repository.js";
import { AlertChecker, buildAlerts } from "./alerts.js";
import { DrizzleMetricsRepository } from "./drizzle-metrics-repository.js";
import { createAdminHealthHandler } from "./health-dashboard.js";
import { MetricsCollector } from "./metrics.js";

function makeMetrics() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gateway_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      minute_key INTEGER NOT NULL,
      capability TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      credit_failures INTEGER NOT NULL DEFAULT 0,
      UNIQUE(minute_key, capability)
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_metrics_minute ON gateway_metrics(minute_key);
  `);
  return new MetricsCollector(new DrizzleMetricsRepository(drizzle(sqlite, { schema })));
}

function makeFleetRepo() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS fleet_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      cleared_at INTEGER
    );
  `);
  return new DrizzleFleetEventRepository(drizzle(sqlite, { schema }));
}

describe("admin health dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
  });

  it("returns JSON with gateway, fleet, billing, and alerts sections", async () => {
    const metrics = makeMetrics();
    metrics.recordGatewayRequest("chat-completions");
    metrics.recordGatewayRequest("chat-completions");
    metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics, makeFleetRepo());
    const checker = new AlertChecker(alerts);

    // Simulate the periodic timer having run at least once
    checker.checkAll();

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
    const metrics = makeMetrics();
    const alerts = buildAlerts(metrics, makeFleetRepo());
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
    const metrics = makeMetrics();
    // Push error rate above 5%
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 10; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics, makeFleetRepo());
    const checker = new AlertChecker(alerts);

    // Simulate the periodic timer having run at least once
    checker.checkAll();

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

  it("does not call checkAll — uses getStatus (read-only)", async () => {
    const metrics = makeMetrics();
    const alerts = buildAlerts(metrics, makeFleetRepo());
    const checker = new AlertChecker(alerts);

    // Spy on checkAll and getStatus
    const checkAllSpy = vi.spyOn(checker, "checkAll");
    const getStatusSpy = vi.spyOn(checker, "getStatus");

    const handler = createAdminHealthHandler({
      metrics,
      alertChecker: checker,
      queryActiveBots: () => 3,
      queryCreditsConsumed24h: () => 100,
    });

    // Make 3 rapid requests (simulating uptime checker polling)
    await handler.request("/");
    await handler.request("/");
    await handler.request("/");

    expect(checkAllSpy).not.toHaveBeenCalled();
    expect(getStatusSpy).toHaveBeenCalledTimes(3);
  });
});
