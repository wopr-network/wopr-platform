import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleSessionUsageRepository, type ISessionUsageRepository } from "./session-usage-repository.js";

describe("DrizzleSessionUsageRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: ISessionUsageRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleSessionUsageRepository(db);
  });

  it("inserts and retrieves by session ID", async () => {
    const record = await repo.insert({
      sessionId: "sess-1",
      userId: "user-1",
      page: "/onboarding/welcome",
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 800,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.0042,
    });
    expect(record.id).toBeTruthy();
    expect(record.sessionId).toBe("sess-1");

    const rows = await repo.findBySessionId("sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBeCloseTo(0.0042);
  });

  it("sums cost by session", async () => {
    await repo.insert({
      sessionId: "sess-2",
      userId: null,
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.002,
    });
    await repo.insert({
      sessionId: "sess-2",
      userId: null,
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.003,
    });
    const total = await repo.sumCostBySession("sess-2");
    expect(total).toBeCloseTo(0.005);
  });

  it("sums cost by user since timestamp", async () => {
    const now = Date.now();
    await repo.insert({
      sessionId: "sess-3",
      userId: "user-2",
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.01,
    });
    const total = await repo.sumCostByUser("user-2", now - 60000);
    expect(total).toBeCloseTo(0.01);

    const empty = await repo.sumCostByUser("user-2", now + 60000);
    expect(empty).toBe(0);
  });

  it("aggregates by day", async () => {
    await repo.insert({
      sessionId: "sess-4",
      userId: null,
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.05,
    });
    const agg = await repo.aggregateByDay(0);
    expect(agg.length).toBeGreaterThanOrEqual(1);
    expect(agg[0].totalCostUsd).toBeCloseTo(0.05);
  });

  it("aggregates by page", async () => {
    await repo.insert({
      sessionId: "sess-5",
      userId: null,
      page: "/onboarding/welcome",
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.02,
    });
    await repo.insert({
      sessionId: "sess-5",
      userId: null,
      page: "/onboarding/superpowers",
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.05,
    });
    const agg = await repo.aggregateByPage(0);
    expect(agg.length).toBe(2);
    const superpowers = agg.find((a) => a.page === "/onboarding/superpowers");
    expect(superpowers?.totalCostUsd).toBeCloseTo(0.05);
  });

  it("calculates cache hit rate and token breakdowns", async () => {
    await repo.insert({
      sessionId: "sess-6",
      userId: null,
      page: null,
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 700,
      cacheWriteTokens: 50,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.01,
    });
    await repo.insert({
      sessionId: "sess-6",
      userId: null,
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 100,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.01,
    });
    const stats = await repo.cacheHitRate(0);
    // hitRate = 700 / 1500 = 0.4667
    expect(stats.hitRate).toBeCloseTo(700 / 1500);
    expect(stats.cachedTokens).toBe(700);
    expect(stats.cacheWriteTokens).toBe(150);
    // uncached = 1500 - 700 - 150 = 650
    expect(stats.uncachedTokens).toBe(650);
  });
});
