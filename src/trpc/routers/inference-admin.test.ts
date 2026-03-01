/**
 * tRPC inference-admin router tests — WOP-1183
 */

import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DailyCostAggregate,
  ISessionUsageRepository,
  PageCostAggregate,
  SessionCostSummary,
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

function memberCtx(userId = "user-1") {
  return {
    user: { id: userId, roles: ["member"] },
    tenantId: "t-member",
  };
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
    aggregateSessionCost: vi.fn().mockResolvedValue({ totalCostUsd: 0, totalSessions: 0, avgCostPerSession: 0 }),
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
    it("returns aggregate session cost summary for time range", async () => {
      const summary: SessionCostSummary = { totalCostUsd: 1.25, totalSessions: 5, avgCostPerSession: 0.25 };
      mockRepo = createMockRepo({
        aggregateSessionCost: vi.fn().mockResolvedValue(summary),
      });
      setInferenceAdminDeps({ getSessionUsageRepo: () => mockRepo });

      const caller = inferenceAdminRouter.createCaller(authedCtx());
      const result = await caller.sessionCost({ since: 1000 });

      expect(result).toEqual(summary);
      expect(mockRepo.aggregateSessionCost).toHaveBeenCalledWith(1000);
    });

    it("rejects negative since via zod validation", async () => {
      const caller = inferenceAdminRouter.createCaller(authedCtx());
      await expect(caller.sessionCost({ since: -1 })).rejects.toThrow();
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

    it("rejects non-admin users on dailyCost with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx() as any);
      await expect(caller.dailyCost({ since: 0 })).rejects.toThrow(TRPCError);
      await expect(caller.dailyCost({ since: 0 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("rejects non-admin users on pageCost with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx() as any);
      await expect(caller.pageCost({ since: 0 })).rejects.toThrow(TRPCError);
      await expect(caller.pageCost({ since: 0 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("rejects non-admin users on cacheHitRate with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx() as any);
      await expect(caller.cacheHitRate({ since: 0 })).rejects.toThrow(TRPCError);
      await expect(caller.cacheHitRate({ since: 0 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("rejects non-admin users on sessionCost with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx() as any);
      await expect(caller.sessionCost({ since: 0 })).rejects.toThrow(TRPCError);
      await expect(caller.sessionCost({ since: 0 })).rejects.toMatchObject({
        code: "FORBIDDEN",
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
