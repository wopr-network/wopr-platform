/**
 * Unit tests for DrizzleMetricsRepository (WOP-927).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../test/db.js";
import { DrizzleMetricsRepository } from "./drizzle-metrics-repository.js";

describe("DrizzleMetricsRepository", () => {
  let pool: PGlite;
  let repo: DrizzleMetricsRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    const { db, pool: p } = await createTestDb();
    pool = p;
    repo = new DrizzleMetricsRepository(db);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool.close();
  });

  it("records and queries gateway requests", async () => {
    await repo.recordGatewayRequest("chat");
    await repo.recordGatewayRequest("chat");
    await repo.recordGatewayError("chat");

    const window = await repo.getWindow(5);
    expect(window.totalRequests).toBe(2);
    expect(window.totalErrors).toBe(1);
    expect(window.byCapability.get("chat")?.requests).toBe(2);
    expect(window.byCapability.get("chat")?.errors).toBe(1);
    expect(window.byCapability.get("chat")?.errorRate).toBe(0.5);
  });

  it("records credit deduction failures", async () => {
    await repo.recordCreditDeductionFailure();
    await repo.recordCreditDeductionFailure();

    const window = await repo.getWindow(5);
    expect(window.creditDeductionFailures).toBe(2);
    expect(window.byCapability.has("__credit_failures__")).toBe(false);
  });

  it("returns empty window when no data", async () => {
    const window = await repo.getWindow(5);
    expect(window.totalRequests).toBe(0);
    expect(window.totalErrors).toBe(0);
    expect(window.errorRate).toBe(0);
    expect(window.creditDeductionFailures).toBe(0);
  });

  it("only includes rows within the time window", async () => {
    await repo.recordGatewayRequest("chat");

    // Advance 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);
    await repo.recordGatewayRequest("tts");

    const window5 = await repo.getWindow(5);
    expect(window5.totalRequests).toBe(1);
    expect(window5.byCapability.has("chat")).toBe(false);

    const window15 = await repo.getWindow(15);
    expect(window15.totalRequests).toBe(2);
  });

  it("prune removes rows older than maxRetentionMinutes", async () => {
    await repo.recordGatewayRequest("chat");

    vi.advanceTimersByTime(10 * 60 * 1000);
    await repo.recordGatewayRequest("tts");

    const removed = await repo.prune(5);
    expect(removed).toBe(1);

    const window = await repo.getWindow(200);
    expect(window.totalRequests).toBe(1);
    expect(window.byCapability.has("tts")).toBe(true);
  });
});
