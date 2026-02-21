import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsCollector } from "./metrics.js";

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector(60);
  });

  it("recordGatewayRequest increments current bucket", () => {
    collector.recordGatewayRequest();
    const window = collector.getWindow(5);
    expect(window.totalRequests).toBe(1);
  });

  it("recordGatewayRequest with capability tracks per-capability counts", () => {
    collector.recordGatewayRequest("llm");
    collector.recordGatewayRequest("llm");
    collector.recordGatewayRequest("tts");
    const buckets = collector.getBuckets();
    expect(buckets.length).toBe(1);
    expect(buckets[0].capabilityRequests["llm"]).toBe(2);
    expect(buckets[0].capabilityRequests["tts"]).toBe(1);
  });

  it("recordGatewayError increments current bucket", () => {
    collector.recordGatewayError();
    const window = collector.getWindow(5);
    expect(window.totalErrors).toBe(1);
  });

  it("recordGatewayError with capability tracks per-capability errors", () => {
    collector.recordGatewayError("llm");
    collector.recordGatewayError("llm");
    const buckets = collector.getBuckets();
    expect(buckets[0].capabilityErrors["llm"]).toBe(2);
  });

  it("recordCreditDeductionFailure increments current bucket", () => {
    collector.recordCreditDeductionFailure();
    const window = collector.getWindow(5);
    expect(window.creditDeductionFailures).toBe(1);
  });

  it("getWindow returns zeros when no data", () => {
    const window = collector.getWindow(5);
    expect(window.totalRequests).toBe(0);
    expect(window.totalErrors).toBe(0);
    expect(window.errorRate).toBe(0);
    expect(window.creditDeductionFailures).toBe(0);
    expect(window.capabilityErrorRates).toEqual({});
  });

  it("getWindow aggregates correctly over 5-minute window", () => {
    collector.recordGatewayRequest("llm");
    collector.recordGatewayRequest("llm");
    collector.recordGatewayError("llm");
    const window = collector.getWindow(5);
    expect(window.totalRequests).toBe(2);
    expect(window.totalErrors).toBe(1);
    expect(window.errorRate).toBe(50);
  });

  it("capabilityErrorRates computed correctly per capability", () => {
    collector.recordGatewayRequest("llm");
    collector.recordGatewayRequest("llm");
    collector.recordGatewayError("llm");
    collector.recordGatewayRequest("tts");
    // No tts errors
    const window = collector.getWindow(5);
    expect(window.capabilityErrorRates["llm"]).toBe(50);
    expect(window.capabilityErrorRates["tts"]).toBeUndefined();
  });

  it("getBuckets returns current state", () => {
    collector.recordGatewayRequest();
    const buckets = collector.getBuckets();
    expect(buckets.length).toBe(1);
    expect(buckets[0].gatewayRequests).toBe(1);
  });

  it("bucket pruning removes old buckets beyond window", () => {
    // Create a short-window collector and then manually manipulate timestamps
    const shortCollector = new MetricsCollector(1); // 1 minute window

    // Record some data
    shortCollector.recordGatewayRequest();
    const buckets = shortCollector.getBuckets();
    expect(buckets.length).toBe(1);

    // Fake the bucket's timestamp to be 2 minutes ago
    const BUCKET_DURATION_MS = 60_000;
    (buckets as unknown as Array<{ timestamp: number }>)[0].timestamp = Date.now() - 2 * BUCKET_DURATION_MS;

    // Next call to getBuckets() will prune
    shortCollector.recordGatewayRequest(); // creates new bucket, triggers prune
    const afterPrune = shortCollector.getBuckets();
    // Old bucket should be pruned
    expect(afterPrune.length).toBe(1);
    expect(afterPrune[0].gatewayRequests).toBe(1);
  });

  it("errorRate is 0 when no requests", () => {
    collector.recordGatewayError();
    // error with no recorded requests → rate 0 (no division by zero)
    const window = collector.getWindow(5);
    expect(window.errorRate).toBe(0);
  });

  it("multiple records accumulate in same bucket", () => {
    for (let i = 0; i < 10; i++) {
      collector.recordGatewayRequest("llm");
    }
    for (let i = 0; i < 3; i++) {
      collector.recordGatewayError("llm");
    }
    const window = collector.getWindow(5);
    expect(window.totalRequests).toBe(10);
    expect(window.totalErrors).toBe(3);
    expect(window.capabilityErrorRates["llm"]).toBe(30);
  });

  it("uses fake timers to avoid flakiness", () => {
    vi.useFakeTimers();
    const timedCollector = new MetricsCollector(60);
    timedCollector.recordGatewayRequest();

    // Advance time beyond the window
    vi.advanceTimersByTime(61 * 60 * 1000);
    timedCollector.recordGatewayRequest(); // new bucket, prunes old

    const window = timedCollector.getWindow(5);
    expect(window.totalRequests).toBe(1); // only the newest bucket counts
    vi.useRealTimers();
  });
});
