/**
 * tRPC inference-admin router tests — WOP-1183
 */

import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DailyCostAggregate,
  ISessionUsageRepository,
  PageCostAggregate,
  SessionUsage,
} from "../../inference/session-usage-repository.js";
import { inferenceAdminRouter, setInferenceAdminDeps } from "./inference-admin.js";

function authedCtx(userId = "admin-1") {
  return {
    user: { id: userId, roles: ["platform_admin"] },
    tenantId: "t-admin",
  };
}

function unauthCtx() {
  return { user: undefined as undefined, tenantId: undefined as string | undefined };
}

function createMockRepo(overrides: Partial<ISessionUsageRepository> = {}): ISessionUsageRepository {
  return {
    insert: vi.fn(),
    findBySessionId: vi.fn().mockResolvedValue([]),
    sumCostByUser: vi.fn().mockResolvedValue(0),
    sumCostBySession: vi.fn().mockResolvedValue(0),
    aggregateByDay: vi.fn().mockResolvedValue([]),
    aggregateByPage: vi.fn().mockResolvedValue([]),
    cacheHitRate: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as ISessionUsageRepository;
}

describe("inference-admin router", () => {
  let mockRepo: ISessionUsageRepository;

  beforeEach(() => {
    mockRepo = createMockRepo();
    setInferenceAdminDeps({ getSessionUsageRepo: () => mockRepo });
  });

  describe("dailyCost", () => {
    it("returns aggregated daily cost data", async () => {
      const data: DailyCostAggregate[] = [
        { day: "2026-02-27", totalCostUsd: 1.5, sessionCount: 3 },
        { day: "2026-02-26", totalCostUsd: 0.8, sessionCount: 2 },
      ];
      mockRepo = createMockRepo({ aggregateByDay: vi.fn().mockResolvedValue(data) });
      setInferenceAdminDeps({ getSessionUsageRepo: () => mockRepo });

      const caller = inferenceAdminRouter.createCaller(authedCtx());
      const result = await caller.dailyCost({ since: 0 });

      expect(result).toEqual(data);
      expect(mockRepo.aggregateByDay).toHaveBeenCalledWith(0);
    });

    it("passes the since parameter through", async () => {
      const caller = inferenceAdminRouter.createCaller(authedCtx());
      await caller.dailyCost({ since: 1700000000000 });
      expect(mockRepo.aggregateByDay).toHaveBeenCalledWith(1700000000000);
    });
  });

  describe("pageCost", () => {
    it("returns aggregated page cost data", async () => {
      const data: PageCostAggregate[] = [{ page: "/dashboard", totalCostUsd: 2.0, callCount: 10, avgCostUsd: 0.2 }];
      mockRepo = createMockRepo({ aggregateByPage: vi.fn().mockResolvedValue(data) });
      setInferenceAdminDeps({ getSessionUsageRepo: () => mockRepo });

      const caller = inferenceAdminRouter.createCaller(authedCtx());
      const result = await caller.pageCost({ since: 0 });

      expect(result).toEqual(data);
    });
  });

  describe("cacheHitRate", () => {
    it("returns cache hit rate wrapped in an object", async () => {
      mockRepo = createMockRepo({ cacheHitRate: vi.fn().mockResolvedValue(0.75) });
      setInferenceAdminDeps({ getSessionUsageRepo: () => mockRepo });

      const caller = inferenceAdminRouter.createCaller(authedCtx());
      const result = await caller.cacheHitRate({ since: 0 });

      expect(result).toEqual({ rate: 0.75 });
    });
  });

  describe("sessionCost", () => {
    it("returns total cost, call count, and records for a session", async () => {
      const records: SessionUsage[] = [
        {
          id: "u1",
          sessionId: "sess-1",
          userId: "user-1",
          page: "/chat",
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 20,
          cacheWriteTokens: 10,
          model: "gpt-4",
          costUsd: 0.05,
          createdAt: Date.now(),
        },
      ];
      mockRepo = createMockRepo({
        sumCostBySession: vi.fn().mockResolvedValue(0.05),
        findBySessionId: vi.fn().mockResolvedValue(records),
      });
      setInferenceAdminDeps({ getSessionUsageRepo: () => mockRepo });

      const caller = inferenceAdminRouter.createCaller(authedCtx());
      const result = await caller.sessionCost({ sessionId: "sess-1" });

      expect(result.totalCostUsd).toBe(0.05);
      expect(result.callCount).toBe(1);
      expect(result.records).toEqual(records);
    });

    it("rejects empty sessionId via zod validation", async () => {
      const caller = inferenceAdminRouter.createCaller(authedCtx());
      await expect(caller.sessionCost({ sessionId: "" })).rejects.toThrow();
    });
  });

  describe("auth guard", () => {
    it("rejects unauthenticated calls with UNAUTHORIZED", async () => {
      const caller = inferenceAdminRouter.createCaller(unauthCtx() as any);
      await expect(caller.dailyCost({ since: 0 })).rejects.toThrow(TRPCError);
      await expect(caller.dailyCost({ since: 0 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("input validation", () => {
    it("rejects negative since values", async () => {
      const caller = inferenceAdminRouter.createCaller(authedCtx());
      await expect(caller.dailyCost({ since: -1 })).rejects.toThrow();
    });

    it("rejects non-integer since values", async () => {
      const caller = inferenceAdminRouter.createCaller(authedCtx());
      await expect(caller.dailyCost({ since: 1.5 })).rejects.toThrow();
    });
  });
});
