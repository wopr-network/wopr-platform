import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../test/db.js";
import { DrizzleMetricsRepository } from "./drizzle-metrics-repository.js";
import { MetricsCollector } from "./metrics.js";

describe("MetricsCollector", () => {
  let pool: PGlite;
  let m: MetricsCollector;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    const { db, pool: p } = await createTestDb();
    pool = p;
    m = new MetricsCollector(new DrizzleMetricsRepository(db));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool.close();
  });

  it("records gateway requests per capability", async () => {
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("tts");
    // allow async fire-and-forget to settle
    await new Promise((r) => setImmediate(r));

    const window = await m.getWindow(5);
    expect(window.totalRequests).toBe(3);
    expect(window.byCapability.get("chat-completions")?.requests).toBe(2);
    expect(window.byCapability.get("tts")?.requests).toBe(1);
  });

  it("records gateway errors per capability", async () => {
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayError("chat-completions");
    await new Promise((r) => setImmediate(r));

    const window = await m.getWindow(5);
    expect(window.totalErrors).toBe(1);
    expect(window.byCapability.get("chat-completions")?.errors).toBe(1);
    expect(window.byCapability.get("chat-completions")?.errorRate).toBe(0.5);
  });

  it("records credit deduction failures", async () => {
    m.recordCreditDeductionFailure();
    m.recordCreditDeductionFailure();
    await new Promise((r) => setImmediate(r));

    const window = await m.getWindow(5);
    expect(window.creditDeductionFailures).toBe(2);
  });

  it("returns zero errorRate when no requests", async () => {
    const window = await m.getWindow(5);
    expect(window.errorRate).toBe(0);
    expect(window.totalRequests).toBe(0);
  });

  it("computes overall errorRate correctly", async () => {
    for (let i = 0; i < 10; i++) m.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 2; i++) m.recordGatewayError("chat-completions");
    await new Promise((r) => setImmediate(r));

    const window = await m.getWindow(5);
    expect(window.errorRate).toBeCloseTo(0.2);
  });
});
