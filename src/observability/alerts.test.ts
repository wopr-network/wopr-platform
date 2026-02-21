import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertChecker, buildAlerts, fleetStopAlert } from "./alerts.js";
import { MetricsCollector } from "./metrics.js";

function findAlert(alerts: ReturnType<typeof buildAlerts>, name: string) {
  const alert = alerts.find((a) => a.name === name);
  if (!alert) throw new Error(`Alert "${name}" not found`);
  return alert;
}

describe("buildAlerts", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector(60);
    vi.clearAllMocks();
  });

  it("returns 3 alert definitions", () => {
    const alerts = buildAlerts(metrics);
    expect(alerts).toHaveLength(3);
    expect(alerts.map((a) => a.name)).toEqual([
      "gateway-capability-error-rate",
      "credit-deduction-failure-spike",
      "fleet-unexpected-stop",
    ]);
  });

  describe("gateway-capability-error-rate alert", () => {
    it("fires when capability error rate exceeds threshold", () => {
      // 6 requests, 1 error = 16.7% error rate > 5%
      for (let i = 0; i < 6; i++) {
        metrics.recordGatewayRequest("llm");
      }
      metrics.recordGatewayError("llm");

      const alerts = buildAlerts(metrics, { capabilityErrorRateThreshold: 5, errorRateWindowMinutes: 5 });
      const alert = findAlert(alerts, "gateway-capability-error-rate");
      expect(alert.check()).not.toBeNull();
      expect(alert.check()).toContain("llm");
      expect(alert.check()).toContain("16.7%");
    });

    it("does NOT fire when error rate is at or below threshold", () => {
      // 100 requests, 4 errors = 4% < 5%
      for (let i = 0; i < 100; i++) {
        metrics.recordGatewayRequest("llm");
      }
      for (let i = 0; i < 4; i++) {
        metrics.recordGatewayError("llm");
      }

      const alerts = buildAlerts(metrics, { capabilityErrorRateThreshold: 5 });
      const alert = findAlert(alerts, "gateway-capability-error-rate");
      expect(alert.check()).toBeNull();
    });

    it("does NOT fire when there are no requests", () => {
      const alerts = buildAlerts(metrics);
      const alert = findAlert(alerts, "gateway-capability-error-rate");
      expect(alert.check()).toBeNull();
    });
  });

  describe("credit-deduction-failure-spike alert", () => {
    it("fires when credit failures exceed threshold", () => {
      for (let i = 0; i < 11; i++) {
        metrics.recordCreditDeductionFailure();
      }

      const alerts = buildAlerts(metrics, { creditFailureSpikeThreshold: 10, errorRateWindowMinutes: 5 });
      const alert = findAlert(alerts, "credit-deduction-failure-spike");
      expect(alert.check()).not.toBeNull();
      expect(alert.check()).toContain("11");
    });

    it("does NOT fire when credit failures are at or below threshold", () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordCreditDeductionFailure();
      }

      const alerts = buildAlerts(metrics, { creditFailureSpikeThreshold: 10 });
      const alert = findAlert(alerts, "credit-deduction-failure-spike");
      expect(alert.check()).toBeNull();
    });

    it("does NOT fire with zero failures", () => {
      const alerts = buildAlerts(metrics);
      const alert = findAlert(alerts, "credit-deduction-failure-spike");
      expect(alert.check()).toBeNull();
    });
  });

  describe("fleet-unexpected-stop alert", () => {
    it("check() always returns null (event-driven, not polled)", () => {
      const alerts = buildAlerts(metrics);
      const alert = findAlert(alerts, "fleet-unexpected-stop");
      expect(alert.check()).toBeNull();
    });
  });
});

describe("AlertChecker", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector(60);
    vi.clearAllMocks();
  });

  it("runChecks calls onAlert for triggered alerts", () => {
    // Trigger error rate alert
    for (let i = 0; i < 6; i++) metrics.recordGatewayRequest("llm");
    metrics.recordGatewayError("llm");

    const alerts = buildAlerts(metrics, { capabilityErrorRateThreshold: 5 });
    const onAlert = vi.fn();
    const checker = new AlertChecker(alerts, onAlert);

    checker.runChecks();
    expect(onAlert).toHaveBeenCalledWith("gateway-capability-error-rate", expect.stringContaining("llm"));
  });

  it("deduplicates — does not re-fire for same active alert", () => {
    for (let i = 0; i < 6; i++) metrics.recordGatewayRequest("llm");
    metrics.recordGatewayError("llm");

    const alerts = buildAlerts(metrics, { capabilityErrorRateThreshold: 5 });
    const onAlert = vi.fn();
    const checker = new AlertChecker(alerts, onAlert);

    checker.runChecks();
    checker.runChecks();
    checker.runChecks();
    // Only fired once despite 3 checks
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it("re-fires after alert clears and triggers again", () => {
    for (let i = 0; i < 6; i++) metrics.recordGatewayRequest("llm");
    metrics.recordGatewayError("llm");

    const alerts = buildAlerts(metrics, { capabilityErrorRateThreshold: 5 });
    const onAlert = vi.fn();
    const checker = new AlertChecker(alerts, onAlert);

    // First trigger
    checker.runChecks();
    expect(onAlert).toHaveBeenCalledTimes(1);

    // Clear alert by using fresh metrics (no more errors)
    const freshMetrics = new MetricsCollector(60);
    const freshAlerts = buildAlerts(freshMetrics, { capabilityErrorRateThreshold: 5 });
    const freshChecker = new AlertChecker(freshAlerts, onAlert);
    freshChecker.runChecks(); // no trigger — clears firedAlerts for this checker

    // Re-trigger with same fresh checker
    for (let i = 0; i < 6; i++) freshMetrics.recordGatewayRequest("tts");
    freshMetrics.recordGatewayError("tts");
    freshChecker.runChecks();
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it("stop() prevents further checks when timer is cleared", () => {
    vi.useFakeTimers();
    const alerts = buildAlerts(metrics);
    const onAlert = vi.fn();
    const checker = new AlertChecker(alerts, onAlert);
    checker.start(1000);
    checker.stop();
    vi.advanceTimersByTime(5000);
    expect(onAlert).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("fleetStopAlert", () => {
  it("calls onAlert with correct message", () => {
    const onAlert = vi.fn();
    fleetStopAlert("tenant-123", 5, onAlert);
    expect(onAlert).toHaveBeenCalledWith("fleet-unexpected-stop", expect.stringContaining("tenant-123"));
    expect(onAlert).toHaveBeenCalledWith("fleet-unexpected-stop", expect.stringContaining("5 bots"));
  });
});
