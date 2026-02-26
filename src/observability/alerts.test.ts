import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleFleetEventRepository } from "../fleet/drizzle-fleet-event-repository.js";
import type { IFleetEventRepository } from "../fleet/fleet-event-repository.js";
import { createTestDb } from "../test/db.js";
import { AlertChecker, buildAlerts } from "./alerts.js";
import { DrizzleMetricsRepository } from "./drizzle-metrics-repository.js";
import { MetricsCollector } from "./metrics.js";

async function makeMetricsAndFleet() {
  const { db, pool } = await createTestDb();
  const metrics = new MetricsCollector(new DrizzleMetricsRepository(db));
  const fleetRepo: IFleetEventRepository = new DrizzleFleetEventRepository(db);
  return { metrics, fleetRepo, pool };
}

describe("buildAlerts", () => {
  let pool: PGlite;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool?.close();
  });

  it("returns 3 alert definitions", async () => {
    const { metrics, fleetRepo, pool: p } = await makeMetricsAndFleet();
    pool = p;
    const alerts = buildAlerts(metrics, fleetRepo);
    expect(alerts).toHaveLength(3);
    expect(alerts.map((a) => a.name)).toEqual([
      "gateway-error-rate",
      "credit-deduction-spike",
      "fleet-unexpected-stop",
    ]);
  });

  it("gateway-error-rate fires when error rate exceeds 5%", async () => {
    const { metrics, fleetRepo, pool: p } = await makeMetricsAndFleet();
    pool = p;
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 6; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics, fleetRepo);
    const gatewayAlert = alerts.find((a) => a.name === "gateway-error-rate");
    expect(gatewayAlert).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: find result is asserted defined above
    const result = await gatewayAlert!.check();
    expect(result.firing).toBe(true);
    expect(result.value).toBeCloseTo(0.06);
  });

  it("gateway-error-rate does not fire when error rate is below 5%", async () => {
    const { metrics, fleetRepo, pool: p } = await makeMetricsAndFleet();
    pool = p;
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 3; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics, fleetRepo);
    // biome-ignore lint/style/noNonNullAssertion: alert name is known to exist
    const result = await alerts.find((a) => a.name === "gateway-error-rate")!.check();
    expect(result.firing).toBe(false);
  });

  it("gateway-error-rate does not fire when there are zero requests", async () => {
    const { metrics, fleetRepo, pool: p } = await makeMetricsAndFleet();
    pool = p;
    const alerts = buildAlerts(metrics, fleetRepo);
    // biome-ignore lint/style/noNonNullAssertion: alert name is known to exist
    const result = await alerts.find((a) => a.name === "gateway-error-rate")!.check();
    expect(result.firing).toBe(false);
  });

  it("credit-deduction-spike fires when failures exceed 10 in 5min", async () => {
    const { metrics, fleetRepo, pool: p } = await makeMetricsAndFleet();
    pool = p;
    for (let i = 0; i < 11; i++) metrics.recordCreditDeductionFailure();

    const alerts = buildAlerts(metrics, fleetRepo);
    // biome-ignore lint/style/noNonNullAssertion: alert name is known to exist
    const result = await alerts.find((a) => a.name === "credit-deduction-spike")!.check();
    expect(result.firing).toBe(true);
    expect(result.value).toBe(11);
  });

  it("credit-deduction-spike does not fire under threshold", async () => {
    const { metrics, fleetRepo, pool: p } = await makeMetricsAndFleet();
    pool = p;
    for (let i = 0; i < 5; i++) metrics.recordCreditDeductionFailure();

    const alerts = buildAlerts(metrics, fleetRepo);
    // biome-ignore lint/style/noNonNullAssertion: alert name is known to exist
    const result = await alerts.find((a) => a.name === "credit-deduction-spike")!.check();
    expect(result.firing).toBe(false);
  });

  it("fleet-unexpected-stop does not fire initially", async () => {
    const { metrics, fleetRepo, pool: p } = await makeMetricsAndFleet();
    pool = p;
    const alerts = buildAlerts(metrics, fleetRepo);
    // biome-ignore lint/style/noNonNullAssertion: alert name is known to exist
    const result = await alerts.find((a) => a.name === "fleet-unexpected-stop")!.check();
    expect(result.firing).toBe(false);
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

  it("getStatus returns cached results from last checkAll", async () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: true, value: 10, threshold: 5, message: "too high" }),
    };
    const checker = new AlertChecker([mockAlert]);
    await checker.checkAll();
    const status = checker.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toEqual({ name: "test-alert", firing: true, message: "too high" });
  });

  it("getStatus does not invoke alert check functions", async () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: false, value: 0, threshold: 5, message: "ok" }),
    };
    const checker = new AlertChecker([mockAlert]);
    await checker.checkAll();
    const callCountAfterCheckAll = mockAlert.check.mock.calls.length;
    checker.getStatus();
    checker.getStatus();
    checker.getStatus();
    expect(mockAlert.check.mock.calls.length).toBe(callCountAfterCheckAll);
  });

  it("getStatus does not mutate firedState (calling it does not consume fleet-stop)", async () => {
    const { metrics, fleetRepo, pool } = await makeMetricsAndFleet();
    const alerts = buildAlerts(metrics, fleetRepo);
    const checker = new AlertChecker(alerts, { fleetEventRepo: fleetRepo });

    await fleetRepo.fireFleetStop();
    await checker.checkAll();
    const statusAfterCheck = checker.getStatus();
    const fleetAlert = statusAfterCheck.find((a: { name: string }) => a.name === "fleet-unexpected-stop");
    expect(fleetAlert).toBeDefined();
    await pool.close();
  });

  it("deduplicates: does not re-fire an already-firing alert", async () => {
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: true, value: 10, threshold: 5, message: "too high" }),
    };

    const checker = new AlertChecker([mockAlert]);
    const first = await checker.checkAll();
    const second = await checker.checkAll();

    expect(first).toHaveLength(1);
    expect(first[0].firing).toBe(true);
    expect(second).toHaveLength(1);
    expect(second[0].firing).toBe(true);
  });

  it("clears alert when check returns not-firing", async () => {
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
    await checker.checkAll();
    expect((await checker.checkAll())[0].firing).toBe(true);

    firing = false;
    const result = await checker.checkAll();
    expect(result[0].firing).toBe(false);
  });

  it("calls onFire callback on not-firing -> firing transition", async () => {
    const onFire = vi.fn();
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: true, value: 10, threshold: 5, message: "too high" }),
    };

    const checker = new AlertChecker([mockAlert], { onFire });
    await checker.checkAll();

    expect(onFire).toHaveBeenCalledOnce();
    expect(onFire).toHaveBeenCalledWith("test-alert", { firing: true, value: 10, threshold: 5, message: "too high" });
  });

  it("calls onResolve callback on firing -> not-firing transition", async () => {
    const onResolve = vi.fn();
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

    const checker = new AlertChecker([mockAlert], { onResolve });
    await checker.checkAll();
    firing = false;
    await checker.checkAll();

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith("test-alert", { firing: false, value: 2, threshold: 5, message: "ok" });
  });

  it("does not call onFire on second consecutive firing check", async () => {
    const onFire = vi.fn();
    const mockAlert = {
      name: "test-alert",
      check: vi.fn().mockReturnValue({ firing: true, value: 10, threshold: 5, message: "too high" }),
    };

    const checker = new AlertChecker([mockAlert], { onFire });
    await checker.checkAll();
    await checker.checkAll();

    expect(onFire).toHaveBeenCalledOnce();
  });

  it("start/stop manages interval", async () => {
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
