/**
 * Unit tests for DrizzleMetricsRepository (WOP-927).
 */
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleMetricsRepository } from "./drizzle-metrics-repository.js";

function makeRepo() {
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
  return { sqlite, repo: new DrizzleMetricsRepository(drizzle(sqlite, { schema })) };
}

describe("DrizzleMetricsRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let repo: DrizzleMetricsRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    const r = makeRepo();
    sqlite = r.sqlite;
    repo = r.repo;
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it("records and queries gateway requests", () => {
    repo.recordGatewayRequest("chat");
    repo.recordGatewayRequest("chat");
    repo.recordGatewayError("chat");

    const window = repo.getWindow(5);
    expect(window.totalRequests).toBe(2);
    expect(window.totalErrors).toBe(1);
    expect(window.byCapability.get("chat")?.requests).toBe(2);
    expect(window.byCapability.get("chat")?.errors).toBe(1);
    expect(window.byCapability.get("chat")?.errorRate).toBe(0.5);
  });

  it("records credit deduction failures", () => {
    repo.recordCreditDeductionFailure();
    repo.recordCreditDeductionFailure();

    const window = repo.getWindow(5);
    expect(window.creditDeductionFailures).toBe(2);
    // Credit failures should not appear in byCapability
    expect(window.byCapability.has("__credit_failures__")).toBe(false);
  });

  it("returns empty window when no data", () => {
    const window = repo.getWindow(5);
    expect(window.totalRequests).toBe(0);
    expect(window.totalErrors).toBe(0);
    expect(window.errorRate).toBe(0);
    expect(window.creditDeductionFailures).toBe(0);
  });

  it("only includes rows within the time window", () => {
    repo.recordGatewayRequest("chat");

    // Advance 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);
    repo.recordGatewayRequest("tts");

    const window5 = repo.getWindow(5);
    expect(window5.totalRequests).toBe(1);
    expect(window5.byCapability.has("chat")).toBe(false);

    const window15 = repo.getWindow(15);
    expect(window15.totalRequests).toBe(2);
  });

  it("prune removes rows older than maxRetentionMinutes", () => {
    // Insert data at t=0, then advance 10 minutes and insert more data.
    // prune(5) should remove the t=0 row (older than 5 minutes) but keep the t=10 row.
    repo.recordGatewayRequest("chat");

    vi.advanceTimersByTime(10 * 60 * 1000);
    repo.recordGatewayRequest("tts");

    const removed = repo.prune(5);
    expect(removed).toBe(1);

    const window = repo.getWindow(200);
    expect(window.totalRequests).toBe(1);
    expect(window.byCapability.has("tts")).toBe(true);
  });
});
