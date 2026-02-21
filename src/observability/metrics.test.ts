import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsCollector } from "./metrics.js";

describe("MetricsCollector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records gateway requests per capability", () => {
    const m = new MetricsCollector();
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("tts");

    const window = m.getWindow(5);
    expect(window.totalRequests).toBe(3);
    expect(window.byCapability.get("chat-completions")?.requests).toBe(2);
    expect(window.byCapability.get("tts")?.requests).toBe(1);
  });

  it("records gateway errors per capability", () => {
    const m = new MetricsCollector();
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayError("chat-completions");

    const window = m.getWindow(5);
    expect(window.totalErrors).toBe(1);
    expect(window.byCapability.get("chat-completions")?.errors).toBe(1);
    expect(window.byCapability.get("chat-completions")?.errorRate).toBe(0.5);
  });

  it("records credit deduction failures", () => {
    const m = new MetricsCollector();
    m.recordCreditDeductionFailure();
    m.recordCreditDeductionFailure();

    const window = m.getWindow(5);
    expect(window.creditDeductionFailures).toBe(2);
  });

  it("only includes buckets within the requested window", () => {
    const m = new MetricsCollector();
    m.recordGatewayRequest("chat-completions");

    // Advance 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);
    m.recordGatewayRequest("tts");

    const window5 = m.getWindow(5);
    expect(window5.totalRequests).toBe(1); // only the tts request
    expect(window5.byCapability.has("chat-completions")).toBe(false);

    const window15 = m.getWindow(15);
    expect(window15.totalRequests).toBe(2); // both
  });

  it("prunes buckets older than 120 minutes", () => {
    const m = new MetricsCollector();
    m.recordGatewayRequest("chat-completions");

    // Advance 130 minutes
    vi.advanceTimersByTime(130 * 60 * 1000);
    m.recordGatewayRequest("tts");

    // The old bucket should be pruned
    const window = m.getWindow(200);
    expect(window.totalRequests).toBe(1); // only the tts request
  });

  it("returns zero errorRate when no requests", () => {
    const m = new MetricsCollector();
    const window = m.getWindow(5);
    expect(window.errorRate).toBe(0);
    expect(window.totalRequests).toBe(0);
  });

  it("computes overall errorRate correctly", () => {
    const m = new MetricsCollector();
    for (let i = 0; i < 10; i++) m.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 2; i++) m.recordGatewayError("chat-completions");

    const window = m.getWindow(5);
    expect(window.errorRate).toBeCloseTo(0.2);
  });
});
