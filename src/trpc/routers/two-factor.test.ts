/**
 * Unit tests for the tRPC two-factor router.
 *
 * Uses the caller pattern — no HTTP transport, no database.
 * Deps are injected via setTwoFactorRouterDeps / setTrpcOrgMemberRepo.
 *
 * IDOR regression: setMandateStatus ignores any tenantId in input (Zod strips
 * unknown fields). The router always uses ctx.tenantId from the bearer token.
 */

import type { IOrgMemberRepository } from "@wopr-network/platform-core/fleet/org-member-repository";
import type {
  ITwoFactorRepository,
  TenantMandateStatus,
} from "@wopr-network/platform-core/security/two-factor-repository";
import type { TRPCContext } from "@wopr-network/platform-core/trpc";
import { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../index.js";
import { setTwoFactorRouterDeps } from "./two-factor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = "token:test-api-key";
const TEST_TENANT_ID = "tenant-abc";
const ROGUE_TENANT_ID = "tenant-evil";

// ---------------------------------------------------------------------------
// Stub org member repo (tenantProcedure requires it; token: users bypass check)
// ---------------------------------------------------------------------------

const stubOrgMemberRepo: IOrgMemberRepository = {
  listMembers: async () => [],
  addMember: async () => {},
  updateMemberRole: async () => {},
  removeMember: async () => {},
  findMember: async () => null,
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

function makeMockRepo(): ITwoFactorRepository {
  return {
    getMandateStatus: vi.fn().mockImplementation(
      async (tenantId: string): Promise<TenantMandateStatus> => ({
        tenantId,
        requireTwoFactor: false,
      }),
    ),
    setMandateStatus: vi.fn().mockImplementation(
      async (tenantId: string, requireTwoFactor: boolean): Promise<TenantMandateStatus> => ({
        tenantId,
        requireTwoFactor,
      }),
    ),
    countMandated: vi.fn().mockResolvedValue(0),
    countTotal: vi.fn().mockResolvedValue(0),
  };
}

function createCaller(ctx: Partial<TRPCContext>) {
  return appRouter.createCaller(ctx as TRPCContext);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("twoFactorRouter", () => {
  let mockRepo: ReturnType<typeof makeMockRepo>;

  // token: prefix bypasses the org member lookup in isAuthedWithTenant
  const authedCtx: Partial<TRPCContext> = {
    user: { id: TEST_USER_ID, roles: ["admin"] },
    tenantId: TEST_TENANT_ID,
  };
  const adminCtx: Partial<TRPCContext> = {
    user: { id: TEST_USER_ID, roles: ["admin"] },
    tenantId: TEST_TENANT_ID,
  };
  const nonAdminCtx: Partial<TRPCContext> = {
    user: { id: TEST_USER_ID, roles: [] },
    tenantId: TEST_TENANT_ID,
  };

  beforeEach(() => {
    setTrpcOrgMemberRepo(stubOrgMemberRepo);
    mockRepo = makeMockRepo();
    setTwoFactorRouterDeps({ twoFactorRepo: mockRepo });
  });

  // -------------------------------------------------------------------------
  // getMandateStatus
  // -------------------------------------------------------------------------

  describe("getMandateStatus", () => {
    it("returns mandate status for the authenticated tenant", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.twoFactor.getMandateStatus();
      expect(result.tenantId).toBe(TEST_TENANT_ID);
      expect(result.requireTwoFactor).toBe(false);
      expect(mockRepo.getMandateStatus).toHaveBeenCalledWith(TEST_TENANT_ID);
    });

    it("returns requireTwoFactor: true when mandate is enabled", async () => {
      (mockRepo.getMandateStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        tenantId: TEST_TENANT_ID,
        requireTwoFactor: true,
      });
      const caller = createCaller(authedCtx);
      const result = await caller.twoFactor.getMandateStatus();
      expect(result.requireTwoFactor).toBe(true);
    });

    it("rejects unauthenticated requests", async () => {
      const caller = createCaller({ user: undefined, tenantId: TEST_TENANT_ID });
      await expect(caller.twoFactor.getMandateStatus()).rejects.toThrow(/Authentication required/);
    });

    it("rejects requests without a tenant context", async () => {
      const caller = createCaller({ user: { id: TEST_USER_ID, roles: [] }, tenantId: undefined });
      await expect(caller.twoFactor.getMandateStatus()).rejects.toThrow(/Tenant context required/);
    });
  });

  // -------------------------------------------------------------------------
  // setMandateStatus
  // -------------------------------------------------------------------------

  describe("setMandateStatus", () => {
    it("sets requireTwoFactor to true using ctx.tenantId", async () => {
      const caller = createCaller(adminCtx);
      const result = await caller.twoFactor.setMandateStatus({ requireTwoFactor: true });
      expect(result.tenantId).toBe(TEST_TENANT_ID);
      expect(result.requireTwoFactor).toBe(true);
      expect(mockRepo.setMandateStatus).toHaveBeenCalledWith(TEST_TENANT_ID, true);
    });

    it("sets requireTwoFactor to false using ctx.tenantId", async () => {
      const caller = createCaller(adminCtx);
      const result = await caller.twoFactor.setMandateStatus({ requireTwoFactor: false });
      expect(result.requireTwoFactor).toBe(false);
      expect(mockRepo.setMandateStatus).toHaveBeenCalledWith(TEST_TENANT_ID, false);
    });

    it("rejects non-admin users", async () => {
      const caller = createCaller(nonAdminCtx);
      await expect(caller.twoFactor.setMandateStatus({ requireTwoFactor: true })).rejects.toThrow(
        /Admin access required/,
      );
    });

    it("rejects unauthenticated requests", async () => {
      const caller = createCaller({ user: undefined, tenantId: TEST_TENANT_ID });
      await expect(caller.twoFactor.setMandateStatus({ requireTwoFactor: true })).rejects.toThrow(
        /Authentication required/,
      );
    });

    // IDOR regression: a rogue tenantId in the input body must be ignored.
    // Zod strips unknown fields — only `requireTwoFactor` is in the schema.
    // The router always reads tenantId from ctx, never from input.
    it("IDOR: ignores rogue tenantId in input — always uses ctx.tenantId", async () => {
      const caller = createCaller(adminCtx);
      // Pass an object with a rogue tenantId field alongside the valid field.
      // TypeScript would normally block this, so we cast through unknown.
      const input = { requireTwoFactor: true, tenantId: ROGUE_TENANT_ID } as unknown as {
        requireTwoFactor: boolean;
      };
      const result = await caller.twoFactor.setMandateStatus(input);
      // The repo must be called with ctx.tenantId, not ROGUE_TENANT_ID
      expect(mockRepo.setMandateStatus).toHaveBeenCalledWith(TEST_TENANT_ID, true);
      expect(mockRepo.setMandateStatus).not.toHaveBeenCalledWith(ROGUE_TENANT_ID, expect.anything());
      expect(result.tenantId).toBe(TEST_TENANT_ID);
    });

    it("tenant_admin role is accepted", async () => {
      const tenantAdminCtx: Partial<TRPCContext> = {
        user: { id: TEST_USER_ID, roles: ["tenant_admin"] },
        tenantId: TEST_TENANT_ID,
      };
      const caller = createCaller(tenantAdminCtx);
      const result = await caller.twoFactor.setMandateStatus({ requireTwoFactor: true });
      expect(result.requireTwoFactor).toBe(true);
    });

    it("platform_admin role is accepted", async () => {
      const platformAdminCtx: Partial<TRPCContext> = {
        user: { id: TEST_USER_ID, roles: ["platform_admin"] },
        tenantId: TEST_TENANT_ID,
      };
      const caller = createCaller(platformAdminCtx);
      const result = await caller.twoFactor.setMandateStatus({ requireTwoFactor: true });
      expect(result.requireTwoFactor).toBe(true);
    });
  });
});
