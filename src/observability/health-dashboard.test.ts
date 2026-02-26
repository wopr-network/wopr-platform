import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleFleetEventRepository } from "../fleet/drizzle-fleet-event-repository.js";
import { createTestDb } from "../test/db.js";
import { AlertChecker, buildAlerts } from "./alerts.js";
import { DrizzleMetricsRepository } from "./drizzle-metrics-repository.js";
import { createAdminHealthHandler } from "./health-dashboard.js";
import { MetricsCollector } from "./metrics.js";

describe("admin health dashboard", () => {
  let pool: PGlite;
  let metrics: MetricsCollector;
  let fleetRepo: DrizzleFleetEventRepository;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    const { db, pool: p } = await createTestDb();
    pool = p;
    metrics = new MetricsCollector(new DrizzleMetricsRepository(db));
    fleetRepo = new DrizzleFleetEventRepository(db);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool.close();
  });

  it("returns JSON with gateway, fleet, billing, and alerts sections", async () => {
    metrics.recordGatewayRequest("chat-completions");
    metrics.recordGatewayRequest("chat-completions");
    metrics.recordGatewayError("chat-completions");
    await new Promise((r) => setImmediate(r));

    const alerts = buildAlerts(metrics, fleetRepo);
    const checker = new AlertChecker(alerts);
    await checker.checkAll();

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
    const alerts = buildAlerts(metrics, fleetRepo);
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

  it("does not call checkAll — uses getStatus (read-only)", async () => {
    const alerts = buildAlerts(metrics, fleetRepo);
    const checker = new AlertChecker(alerts);

    const checkAllSpy = vi.spyOn(checker, "checkAll");
    const getStatusSpy = vi.spyOn(checker, "getStatus");

    const handler = createAdminHealthHandler({
      metrics,
      alertChecker: checker,
      queryActiveBots: () => 3,
      queryCreditsConsumed24h: () => 100,
    });

    await handler.request("/");
    await handler.request("/");
    await handler.request("/");

    expect(checkAllSpy).not.toHaveBeenCalled();
    expect(getStatusSpy).toHaveBeenCalledTimes(3);
  });
});
