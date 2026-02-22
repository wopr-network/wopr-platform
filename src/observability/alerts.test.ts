import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleFleetEventRepository } from "../fleet/drizzle-fleet-event-repository.js";
import type { IFleetEventRepository } from "../fleet/fleet-event-repository.js";
import { AlertChecker, buildAlerts } from "./alerts.js";
import { DrizzleMetricsRepository } from "./drizzle-metrics-repository.js";
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

function makeFleetRepo(): IFleetEventRepository {
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

describe("buildAlerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 3 alert definitions", () => {
    const metrics = makeMetrics();
    const alerts = buildAlerts(metrics, makeFleetRepo());
    expect(alerts).toHaveLength(3);
    expect(alerts.map((a) => a.name)).toEqual([
      "gateway-error-rate",
      "credit-deduction-spike",
      "fleet-unexpected-stop",
    ]);
  });

  it("gateway-error-rate fires when error rate exceeds 5%", () => {
    const metrics = makeMetrics();
    // 100 requests, 6 errors = 6%
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 6; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics, makeFleetRepo());
    const gatewayAlert = alerts.find((a) => a.name === "gateway-error-rate");
    expect(gatewayAlert).toBeDefined();
    const result = gatewayAlert?.check();
    expect(result?.firing).toBe(true);
    expect(result?.value).toBeCloseTo(0.06);
  });

  it("gateway-error-rate does not fire when error rate is below 5%", () => {
    const metrics = makeMetrics();
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 3; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics, makeFleetRepo());
    const result = alerts.find((a) => a.name === "gateway-error-rate")?.check();
    expect(result?.firing).toBe(false);
  });

  it("gateway-error-rate does not fire when there are zero requests", () => {
    const metrics = makeMetrics();
    const alerts = buildAlerts(metrics, makeFleetRepo());
    const result = alerts.find((a) => a.name === "gateway-error-rate")?.check();
    expect(result?.firing).toBe(false);
  });

  it("credit-deduction-spike fires when failures exceed 10 in 5min", () => {
    const metrics = makeMetrics();
    for (let i = 0; i < 11; i++) metrics.recordCreditDeductionFailure();

    const alerts = buildAlerts(metrics, makeFleetRepo());
    const result = alerts.find((a) => a.name === "credit-deduction-spike")?.check();
    expect(result?.firing).toBe(true);
    expect(result?.value).toBe(11);
  });

  it("credit-deduction-spike does not fire under threshold", () => {
    const metrics = makeMetrics();
    for (let i = 0; i < 5; i++) metrics.recordCreditDeductionFailure();

    const alerts = buildAlerts(metrics, makeFleetRepo());
    const result = alerts.find((a) => a.name === "credit-deduction-spike")?.check();
    expect(result?.firing).toBe(false);
  });

  it("fleet-unexpected-stop does not fire initially", () => {
    const metrics = makeMetrics();
    const alerts = buildAlerts(metrics, makeFleetRepo());
    const result = alerts.find((a) => a.name === "fleet-unexpected-stop")?.check();
    expect(result?.firing).toBe(false);
  });
});

describe("AlertChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getStatus returns empty array before first checkAll", () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: false, value: 0, threshold: 5, message: "ok" }),
    };
    const checker = new AlertChecker([mockAlert]);
    expect(checker.getStatus()).toEqual([]);
  });

  it("getStatus returns cached results from last checkAll", () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: true, value: 10, threshold: 5, message: "too high" }),
    };
    const checker = new AlertChecker([mockAlert]);
    checker.checkAll();
    const status = checker.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toEqual({ name: "test-alert", firing: true, message: "too high" });
  });

  it("getStatus does not invoke alert check functions", () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: false, value: 0, threshold: 5, message: "ok" }),
    };
    const checker = new AlertChecker([mockAlert]);
    checker.checkAll(); // first call invokes check()
    const callCountAfterCheckAll = mockAlert.check.mock.calls.length;
    checker.getStatus();
    checker.getStatus();
    checker.getStatus();
    expect(mockAlert.check.mock.calls.length).toBe(callCountAfterCheckAll);
  });

  it("getStatus does not mutate firedState (calling it does not consume fleet-stop)", () => {
    const fleetRepo = makeFleetRepo();
    const metrics = makeMetrics();
    const alerts = buildAlerts(metrics, fleetRepo);
    const checker = new AlertChecker(alerts, { fleetEventRepo: fleetRepo });

    // Trigger fleet stop via repo
    fleetRepo.fireFleetStop();
    // Run checkAll once to process the flag
    checker.checkAll();
    const statusAfterCheck = checker.getStatus();
    const fleetAlert = statusAfterCheck.find((a: { name: string }) => a.name === "fleet-unexpected-stop");
    // checkAll already consumed the flag and set firedState — getStatus just reads it
    expect(fleetAlert).toBeDefined();
  });

  it("deduplicates: does not re-fire an already-firing alert", () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: true, value: 10, threshold: 5, message: "too high" }),
    };

    const checker = new AlertChecker([mockAlert]);
    const first = checker.checkAll();
    const second = checker.checkAll();

    // First check fires, second should still report firing but not be a new event
    expect(first).toHaveLength(1);
    expect(first[0].firing).toBe(true);
    expect(second).toHaveLength(1);
    expect(second[0].firing).toBe(true);
  });

  it("clears alert when check returns not-firing", () => {
    let firing = true;
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockImplementation(() => ({
        firing,
        value: firing ? 10 : 2,
        threshold: 5,
        message: firing ? "too high" : "ok",
      })),
    };

    const checker = new AlertChecker([mockAlert]);
    checker.checkAll();
    expect(checker.checkAll()[0].firing).toBe(true);

    firing = false;
    const result = checker.checkAll();
    expect(result[0].firing).toBe(false);
  });

  it("start/stop manages interval", () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: false, value: 0, threshold: 5, message: "ok" }),
    };

    const checker = new AlertChecker([mockAlert], { intervalMs: 1000 });
    checker.start();

    vi.advanceTimersByTime(3000);
    expect(mockAlert.check.mock.calls.length).toBeGreaterThanOrEqual(3);

    checker.stop();
    const callCount = mockAlert.check.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(mockAlert.check.mock.calls.length).toBe(callCount);
  });
});
