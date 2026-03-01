import { describe, expect, it, vi } from "vitest";
import type { CacheStats, ISessionUsageRepository } from "../../inference/session-usage-repository.js";
import { createAdminInferenceRoutes } from "./admin-inference.js";

/** Generate a YYYY-MM-DD string for N days ago. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function mockRepo(overrides: Partial<ISessionUsageRepository> = {}): ISessionUsageRepository {
  return {
    insert: vi.fn(),
    findBySessionId: vi.fn().mockResolvedValue([]),
    sumCostByUser: vi.fn().mockResolvedValue(0),
    sumCostBySession: vi.fn().mockResolvedValue(0),
    aggregateByDay: vi.fn().mockResolvedValue([]),
    aggregateByPage: vi.fn().mockResolvedValue([]),
    cacheHitRate: vi
      .fn()
      .mockResolvedValue({ hitRate: 0, cachedTokens: 0, cacheWriteTokens: 0, uncachedTokens: 0 } satisfies CacheStats),
    aggregateSessionCost: vi.fn().mockResolvedValue({ totalCostUsd: 0, totalSessions: 0, avgCostPerSession: 0 }),
    ...overrides,
  };
}

describe("createAdminInferenceRoutes", () => {
  it("GET / returns summary with zeroes when no data", async () => {
    const repo = mockRepo();
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/");
    const res = await routes.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { totalCostUsd: number; totalSessions: number; avgCostPerSessionUsd: number; cacheHitRate: number };
    };
    expect(body.summary.totalCostUsd).toBe(0);
    expect(body.summary.totalSessions).toBe(0);
    expect(body.summary.avgCostPerSessionUsd).toBe(0);
    expect(body.summary.cacheHitRate).toBe(0);
  });

  it("GET / aggregates totals from daily cost data", async () => {
    const repo = mockRepo({
      aggregateByDay: vi.fn().mockResolvedValue([
        { day: daysAgo(1), totalCostUsd: 0.05, sessionCount: 10 },
        { day: daysAgo(2), totalCostUsd: 0.03, sessionCount: 5 },
      ]),
    });
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/");
    const res = await routes.fetch(req);
    const body = (await res.json()) as {
      summary: { totalCostUsd: number; totalSessions: number; avgCostPerSessionUsd: number };
    };
    expect(body.summary.totalCostUsd).toBeCloseTo(0.08);
    expect(body.summary.totalSessions).toBe(15);
    expect(body.summary.avgCostPerSessionUsd).toBeCloseTo(0.08 / 15);
  });

  it("GET /daily returns daily cost array", async () => {
    const repo = mockRepo({
      aggregateByDay: vi.fn().mockResolvedValue([{ day: daysAgo(1), totalCostUsd: 0.02, sessionCount: 3 }]),
    });
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/daily");
    const res = await routes.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dailyCosts: Array<{ day: string }> };
    expect(body.dailyCosts).toHaveLength(1);
  });

  it("GET /pages returns page cost array", async () => {
    const repo = mockRepo({
      aggregateByPage: vi
        .fn()
        .mockResolvedValue([{ page: "/onboarding/welcome", totalCostUsd: 0.05, callCount: 10, avgCostUsd: 0.005 }]),
    });
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/pages");
    const res = await routes.fetch(req);
    const body = (await res.json()) as { pageCosts: Array<{ page: string }> };
    expect(body.pageCosts[0].page).toBe("/onboarding/welcome");
  });

  it("GET /cache returns cache stats", async () => {
    const stats: CacheStats = { hitRate: 0.72, cachedTokens: 720, cacheWriteTokens: 50, uncachedTokens: 280 };
    const repo = mockRepo({ cacheHitRate: vi.fn().mockResolvedValue(stats) });
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/cache");
    const res = await routes.fetch(req);
    const body = (await res.json()) as { cacheStats: CacheStats };
    expect(body.cacheStats.hitRate).toBeCloseTo(0.72);
    expect(body.cacheStats.cachedTokens).toBe(720);
    expect(body.cacheStats.cacheWriteTokens).toBe(50);
    expect(body.cacheStats.uncachedTokens).toBe(280);
  });

  it("GET /session/:sessionId returns per-session usage", async () => {
    const repo = mockRepo({
      findBySessionId: vi.fn().mockResolvedValue([
        {
          id: "rec-1",
          sessionId: "sess-xyz",
          userId: null,
          page: null,
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: 800,
          cacheWriteTokens: 0,
          model: "claude-sonnet-4-20250514",
          costUsd: 0.003,
          createdAt: Date.now(),
        },
      ]),
    });
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/session/sess-xyz");
    const res = await routes.fetch(req);
    const body = (await res.json()) as { sessionId: string; totalCostUsd: number; records: unknown[] };
    expect(body.sessionId).toBe("sess-xyz");
    expect(body.totalCostUsd).toBeCloseTo(0.003);
    expect(body.records).toHaveLength(1);
  });

  it("GET / respects days query param", async () => {
    const repo = mockRepo();
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/?days=14");
    await routes.fetch(req);
    expect(repo.aggregateByDay).toHaveBeenCalled();
    const call = (repo.aggregateByDay as ReturnType<typeof vi.fn>).mock.calls[0][0] as number;
    const expectedSince = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(call).toBeGreaterThan(expectedSince - 5000);
    expect(call).toBeLessThan(expectedSince + 5000);
  });

  it("GET / returns 500 on repository error", async () => {
    const repo = mockRepo({
      aggregateByDay: vi.fn().mockRejectedValue(new Error("DB down")),
    });
    const routes = createAdminInferenceRoutes(() => repo);
    const req = new Request("http://localhost/");
    const res = await routes.fetch(req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("DB down");
  });
});
