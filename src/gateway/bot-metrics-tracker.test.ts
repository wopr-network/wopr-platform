import { beforeEach, describe, expect, it } from "vitest";
import { BotMetricsTracker } from "./bot-metrics-tracker.js";

describe("BotMetricsTracker", () => {
  let tracker: BotMetricsTracker;

  beforeEach(() => {
    tracker = new BotMetricsTracker();
  });

  it("returns null for unknown bot", () => {
    expect(tracker.getMetrics("unknown-id")).toBeNull();
  });

  it("records request and increments count", () => {
    tracker.recordRequest("bot-1", 100);
    const m = tracker.getMetrics("bot-1");
    expect(m).not.toBeNull();
    expect(m?.requestCount).toBe(1);
    expect(m?.errorCount).toBe(0);
  });

  it("records error and increments error count", () => {
    tracker.recordRequest("bot-1", 50);
    tracker.recordError("bot-1");
    const m = tracker.getMetrics("bot-1");
    expect(m?.requestCount).toBe(1);
    expect(m?.errorCount).toBe(1);
  });

  it("computes P50 and P95 latency", () => {
    for (let i = 1; i <= 100; i++) {
      tracker.recordRequest("bot-1", i);
    }
    const m = tracker.getMetrics("bot-1");
    if (m == null) throw new Error("expected metrics");
    expect(m.requestCount).toBe(100);
    expect(m.latencyP50Ms).toBe(50);
    expect(m.latencyP95Ms).toBe(95);
    expect(m.latencyAvgMs).toBe(50.5);
  });

  it("resets metrics for a bot", () => {
    tracker.recordRequest("bot-1", 100);
    tracker.reset("bot-1");
    expect(tracker.getMetrics("bot-1")).toBeNull();
  });

  it("bounds latency buffer to 1000 samples", () => {
    for (let i = 0; i < 1500; i++) {
      tracker.recordRequest("bot-1", 10);
    }
    const m = tracker.getMetrics("bot-1");
    if (m == null) throw new Error("expected metrics");
    expect(m.requestCount).toBe(1500);
    expect(m.latencyP50Ms).toBe(10);
  });
});
