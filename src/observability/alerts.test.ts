import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChecker, buildAlerts } from "./alerts.js";
import { MetricsCollector } from "./metrics.js";

describe("buildAlerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 3 alert definitions", () => {
    const metrics = new MetricsCollector();
    const alerts = buildAlerts(metrics);
    expect(alerts).toHaveLength(3);
    expect(alerts.map((a) => a.name)).toEqual([
      "gateway-error-rate",
      "credit-deduction-spike",
      "fleet-unexpected-stop",
    ]);
  });

  it("gateway-error-rate fires when error rate exceeds 5%", () => {
    const metrics = new MetricsCollector();
    // 100 requests, 6 errors = 6%
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 6; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics);
    const gatewayAlert = alerts.find((a) => a.name === "gateway-error-rate");
    expect(gatewayAlert).toBeDefined();
    const result = gatewayAlert?.check();
    expect(result?.firing).toBe(true);
    expect(result?.value).toBeCloseTo(0.06);
  });

  it("gateway-error-rate does not fire when error rate is below 5%", () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 100; i++) metrics.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 3; i++) metrics.recordGatewayError("chat-completions");

    const alerts = buildAlerts(metrics);
    const result = alerts.find((a) => a.name === "gateway-error-rate")?.check();
    expect(result?.firing).toBe(false);
  });

  it("gateway-error-rate does not fire when there are zero requests", () => {
    const metrics = new MetricsCollector();
    const alerts = buildAlerts(metrics);
    const result = alerts.find((a) => a.name === "gateway-error-rate")?.check();
    expect(result?.firing).toBe(false);
  });

  it("credit-deduction-spike fires when failures exceed 10 in 5min", () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 11; i++) metrics.recordCreditDeductionFailure();

    const alerts = buildAlerts(metrics);
    const result = alerts.find((a) => a.name === "credit-deduction-spike")?.check();
    expect(result?.firing).toBe(true);
    expect(result?.value).toBe(11);
  });

  it("credit-deduction-spike does not fire under threshold", () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 5; i++) metrics.recordCreditDeductionFailure();

    const alerts = buildAlerts(metrics);
    const result = alerts.find((a) => a.name === "credit-deduction-spike")?.check();
    expect(result?.firing).toBe(false);
  });

  it("fleet-unexpected-stop does not fire initially", () => {
    const metrics = new MetricsCollector();
    const alerts = buildAlerts(metrics);
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
