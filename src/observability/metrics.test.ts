import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
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
  const repo = new DrizzleMetricsRepository(drizzle(sqlite, { schema }));
  return { sqlite, m: new MetricsCollector(repo) };
}

describe("MetricsCollector", () => {
  let sqlite: BetterSqlite3.Database;
  let m: MetricsCollector;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    const r = makeMetrics();
    sqlite = r.sqlite;
    m = r.m;
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it("records gateway requests per capability", () => {
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("tts");

    const window = m.getWindow(5);
    expect(window.totalRequests).toBe(3);
    expect(window.byCapability.get("chat-completions")?.requests).toBe(2);
    expect(window.byCapability.get("tts")?.requests).toBe(1);
  });

  it("records gateway errors per capability", () => {
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayRequest("chat-completions");
    m.recordGatewayError("chat-completions");

    const window = m.getWindow(5);
    expect(window.totalErrors).toBe(1);
    expect(window.byCapability.get("chat-completions")?.errors).toBe(1);
    expect(window.byCapability.get("chat-completions")?.errorRate).toBe(0.5);
  });

  it("records credit deduction failures", () => {
    m.recordCreditDeductionFailure();
    m.recordCreditDeductionFailure();

    const window = m.getWindow(5);
    expect(window.creditDeductionFailures).toBe(2);
  });

  it("only includes buckets within the requested window", () => {
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
    m.recordGatewayRequest("chat-completions");

    // Advance 130 minutes
    vi.advanceTimersByTime(130 * 60 * 1000);
    m.recordGatewayRequest("tts");

    // The old bucket should be pruned
    const window = m.getWindow(200);
    expect(window.totalRequests).toBe(1); // only the tts request
  });

  it("returns zero errorRate when no requests", () => {
    const window = m.getWindow(5);
    expect(window.errorRate).toBe(0);
    expect(window.totalRequests).toBe(0);
  });

  it("computes overall errorRate correctly", () => {
    for (let i = 0; i < 10; i++) m.recordGatewayRequest("chat-completions");
    for (let i = 0; i < 2; i++) m.recordGatewayError("chat-completions");

    const window = m.getWindow(5);
    expect(window.errorRate).toBeCloseTo(0.2);
  });
});
