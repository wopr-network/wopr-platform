/**
 * Unit tests for the tRPC account router.
 *
 * Uses the caller pattern — no HTTP transport, no database.
 * Deps are injected via setAccountRouterDeps / setTrpcOrgMemberRepo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDeletionStore } from "../../account/deletion-store.js";
import type { DeletionRequest } from "../../account/repository-types.js";
import type { IOrgMemberRepository } from "../../fleet/org-member-repository.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
import { setTrpcOrgMemberRepo } from "../init.js";
import type { AccountRouterDeps } from "./account.js";
import { setAccountRouterDeps } from "./account.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = "user-1";
const TEST_TENANT_ID = "tenant-1";
const TEST_EMAIL = "user@example.com";

// ---------------------------------------------------------------------------
// Stub org member repo (for tenantProcedure middleware)
// ---------------------------------------------------------------------------

const stubOrgMemberRepo: IOrgMemberRepository = {
  listMembers: async () => [],
  addMember: async () => {},
  updateMemberRole: async () => {},
  removeMember: async () => {},
  findMember: async (orgId, userId) =>
    orgId === TEST_TENANT_ID && userId === TEST_USER_ID
      ? { id: "mem-1", orgId, userId, role: "owner", joinedAt: Date.now() }
      : null,
  countAdminsAndOwners: async () => 1,
  listInvites: async () => [],
  createInvite: async () => {},
  findInviteById: async () => null,
  findInviteByToken: async () => null,
  deleteInvite: async () => {},
  deleteAllMembers: async () => {},
  deleteAllInvites: async () => {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_DELETION_REQUEST: DeletionRequest = {
  id: "del-1",
  tenantId: TEST_TENANT_ID,
  requestedBy: TEST_USER_ID,
  status: "pending",
  deleteAfter: "2026-03-30T00:00:00Z",
  cancelReason: null,
  completedAt: null,
  deletionSummary: null,
  createdAt: "2026-02-28T00:00:00Z",
  updatedAt: "2026-02-28T00:00:00Z",
};

function makeMockDeletionStore(
  overrides: Partial<Record<keyof AccountDeletionStore, unknown>> = {},
): AccountDeletionStore {
  return {
    create: vi.fn().mockResolvedValue(SAMPLE_DELETION_REQUEST),
    getPendingForTenant: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue(null),
    cancel: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    findExpired: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as AccountDeletionStore;
}

function createCaller(ctx: Partial<TRPCContext>) {
  return appRouter.createCaller(ctx as TRPCContext);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("accountRouter", () => {
  let mockStore: ReturnType<typeof makeMockDeletionStore>;
  let deps: AccountRouterDeps;

  beforeEach(() => {
    setTrpcOrgMemberRepo(stubOrgMemberRepo);
    mockStore = makeMockDeletionStore();
    deps = {
      getDeletionStore: () => mockStore,
      getUserEmail: vi.fn().mockReturnValue(TEST_EMAIL),
      verifyPassword: vi.fn().mockResolvedValue(true),
    };
    setAccountRouterDeps(deps);
  });

  const authedCtx: Partial<TRPCContext> = {
    user: { id: TEST_USER_ID, roles: [] },
    tenantId: TEST_TENANT_ID,
  };

  // -------------------------------------------------------------------------
  // requestDeletion
  // -------------------------------------------------------------------------

  describe("requestDeletion", () => {
    it("creates a deletion request with grace period", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.account.requestDeletion({
        confirmPhrase: "DELETE MY ACCOUNT",
        currentPassword: "password123",
      });

      expect(result.status).toBe("pending");
      expect(result.requestId).toBe("del-1");
      expect(result.deleteAfter).toBe("2026-03-30T00:00:00Z");
      expect(mockStore.create).toHaveBeenCalledWith(TEST_TENANT_ID, TEST_USER_ID);
      expect(deps.verifyPassword).toHaveBeenCalledWith(TEST_EMAIL, "password123");
    });

    it("rejects when a deletion is already pending", async () => {
      (mockStore.getPendingForTenant as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAMPLE_DELETION_REQUEST,
        id: "del-existing",
      });

      const caller = createCaller(authedCtx);
      await expect(
        caller.account.requestDeletion({
          confirmPhrase: "DELETE MY ACCOUNT",
          currentPassword: "password123",
        }),
      ).rejects.toThrow(/already pending/);
    });

    it("rejects when password verification fails", async () => {
      (deps.verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const caller = createCaller(authedCtx);
      await expect(
        caller.account.requestDeletion({
          confirmPhrase: "DELETE MY ACCOUNT",
          currentPassword: "wrong",
        }),
      ).rejects.toThrow(/Password verification failed/);
    });

    it("rejects unauthenticated calls", async () => {
      const caller = createCaller({ user: undefined, tenantId: TEST_TENANT_ID });
      await expect(
        caller.account.requestDeletion({
          confirmPhrase: "DELETE MY ACCOUNT",
          currentPassword: "password123",
        }),
      ).rejects.toThrow(/Authentication required/);
    });

    it("calls suspendBots and suspendTenant when provided", async () => {
      const suspendBots = vi.fn();
      const suspendTenant = vi.fn();
      setAccountRouterDeps({ ...deps, suspendBots, suspendTenant });

      const caller = createCaller(authedCtx);
      await caller.account.requestDeletion({
        confirmPhrase: "DELETE MY ACCOUNT",
        currentPassword: "password123",
      });

      expect(suspendBots).toHaveBeenCalledWith(TEST_TENANT_ID);
      expect(suspendTenant).toHaveBeenCalledWith(TEST_TENANT_ID, "Account deletion requested", TEST_USER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // deletionStatus
  // -------------------------------------------------------------------------

  describe("deletionStatus", () => {
    it("returns hasPendingDeletion: false when no request exists", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.account.deletionStatus();
      expect(result.hasPendingDeletion).toBe(false);
    });

    it("returns pending request details when one exists", async () => {
      (mockStore.getPendingForTenant as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_DELETION_REQUEST);

      const caller = createCaller(authedCtx);
      const result = await caller.account.deletionStatus();
      expect(result.hasPendingDeletion).toBe(true);
      if (result.hasPendingDeletion) {
        expect(result.requestId).toBe("del-1");
        expect(result.deleteAfter).toBe("2026-03-30T00:00:00Z");
      }
    });
  });

  // -------------------------------------------------------------------------
  // cancelDeletion
  // -------------------------------------------------------------------------

  describe("cancelDeletion", () => {
    const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

    it("cancels a pending deletion request", async () => {
      (mockStore.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAMPLE_DELETION_REQUEST,
        id: REQUEST_ID,
      });

      const caller = createCaller(authedCtx);
      const result = await caller.account.cancelDeletion({ requestId: REQUEST_ID });
      expect(result.cancelled).toBe(true);
      expect(mockStore.cancel).toHaveBeenCalledWith(REQUEST_ID, `Cancelled by user ${TEST_USER_ID}`);
    });

    it("rejects cancellation of another tenant's request", async () => {
      (mockStore.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAMPLE_DELETION_REQUEST,
        id: REQUEST_ID,
        tenantId: "other-tenant",
      });

      const caller = createCaller(authedCtx);
      await expect(caller.account.cancelDeletion({ requestId: REQUEST_ID })).rejects.toThrow(/not found/i);
    });

    it("rejects cancellation of non-pending request", async () => {
      (mockStore.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAMPLE_DELETION_REQUEST,
        id: REQUEST_ID,
        status: "completed",
      });

      const caller = createCaller(authedCtx);
      await expect(caller.account.cancelDeletion({ requestId: REQUEST_ID })).rejects.toThrow(/no longer pending/i);
    });

    it("rejects when deletion request does not exist", async () => {
      (mockStore.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const caller = createCaller(authedCtx);
      await expect(caller.account.cancelDeletion({ requestId: REQUEST_ID })).rejects.toThrow(/not found/i);
    });
  });
});
