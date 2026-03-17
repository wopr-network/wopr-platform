/**
 * tRPC inference-admin router tests — WOP-1183
 */

import type {
  CacheStats,
  DailyCostAggregate,
  ISessionUsageRepository,
  PageCostAggregate,
  SessionCostSummary,
} from "@wopr-network/platform-core/inference/session-usage-repository";
import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import type { TRPCContext } from "@wopr-network/platform-core/trpc";
import { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inferenceAdminRouter, setInferenceAdminDeps } from "./inference-admin.js";

// Wire org member repo so isAuthed middleware doesn't throw INTERNAL_SERVER_ERROR
beforeAll(() => {
  setTrpcOrgMemberRepo({
    findMember: vi.fn().mockResolvedValue({ id: "m1", orgId: "t-1", userId: "user-1", role: "member", joinedAt: 0 }),
    listMembers: vi.fn(),
    addMember: vi.fn(),
    updateMemberRole: vi.fn(),
    removeMember: vi.fn(),
    countAdminsAndOwners: vi.fn(),
    listInvites: vi.fn(),
    createInvite: vi.fn(),
    findInviteById: vi.fn(),
    findInviteByToken: vi.fn(),
    deleteInvite: vi.fn(),
    deleteAllMembers: vi.fn(),
    deleteAllInvites: vi.fn(),
    listOrgsByUser: vi.fn().mockResolvedValue([]),
    markInviteAccepted: vi.fn().mockResolvedValue(undefined),
  } as IOrgMemberRepository);
});

function authedCtx(userId = "admin-1") {
  return {
    user: { id: userId, roles: ["platform_admin"] },
    tenantId: "t-admin",
  };
}

function unauthCtx(): TRPCContext {
  return { user: undefined, tenantId: undefined };
}

function memberCtx(userId = "user-1"): TRPCContext {
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
    cacheHitRate: vi.fn().mockResolvedValue({ hitRate: 0, cachedTokens: 0, cacheWriteTokens: 0, uncachedTokens: 0 }),
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
    it("returns full CacheStats object", async () => {
      const stats: CacheStats = { hitRate: 0.75, cachedTokens: 750, cacheWriteTokens: 50, uncachedTokens: 200 };
      mockRepo = createMockRepo({ cacheHitRate: vi.fn().mockResolvedValue(stats) });
      setInferenceAdminDeps({ getSessionUsageRepo: () => mockRepo });

      const caller = inferenceAdminRouter.createCaller(authedCtx());
      const result = await caller.cacheHitRate({ since: 0 });

      expect(result).toEqual(stats);
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
      const caller = inferenceAdminRouter.createCaller(unauthCtx());
      await expect(caller.dailyCost({ since: 0 })).rejects.toThrow();
      await expect(caller.dailyCost({ since: 0 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("rejects non-admin users on dailyCost with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx());
      await expect(caller.dailyCost({ since: 0 })).rejects.toThrow();
      await expect(caller.dailyCost({ since: 0 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("rejects non-admin users on pageCost with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx());
      await expect(caller.pageCost({ since: 0 })).rejects.toThrow();
      await expect(caller.pageCost({ since: 0 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("rejects non-admin users on cacheHitRate with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx());
      await expect(caller.cacheHitRate({ since: 0 })).rejects.toThrow();
      await expect(caller.cacheHitRate({ since: 0 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("rejects non-admin users on sessionCost with FORBIDDEN", async () => {
      const caller = inferenceAdminRouter.createCaller(memberCtx());
      await expect(caller.sessionCost({ since: 0 })).rejects.toThrow();
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
