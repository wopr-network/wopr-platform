import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import { adminProcedure, router, setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wire a permissive org member repo so isAuthed doesn't throw INTERNAL_SERVER_ERROR
// when tenantId is present on non-admin users
beforeEach(() => {
  setTrpcOrgMemberRepo({
    findMember: vi.fn().mockResolvedValue({ id: "m1", orgId: "org-1", userId: "user-1", role: "member", joinedAt: 0 }),
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

describe("adminProcedure", () => {
  const testRouter = router({
    adminOnly: adminProcedure.query(() => "ok"),
  });

  it("rejects unauthenticated users with UNAUTHORIZED", async () => {
    const caller = testRouter.createCaller({ user: undefined, tenantId: undefined });
    await expect(caller.adminOnly()).rejects.toThrow();
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects authenticated non-admin users with FORBIDDEN", async () => {
    const caller = testRouter.createCaller({
      user: { id: "user-1", roles: ["member"] },
      tenantId: "t-1",
    });
    await expect(caller.adminOnly()).rejects.toThrow();
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects users with empty roles with FORBIDDEN", async () => {
    const caller = testRouter.createCaller({
      user: { id: "user-2", roles: [] },
      tenantId: "t-1",
    });
    await expect(caller.adminOnly()).rejects.toThrow();
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows platform_admin users through", async () => {
    const caller = testRouter.createCaller({
      user: { id: "admin-1", roles: ["platform_admin"] },
      tenantId: "t-1",
    });
    const result = await caller.adminOnly();
    expect(result).toBe("ok");
  });

  it("allows users with platform_admin among other roles", async () => {
    const caller = testRouter.createCaller({
      user: { id: "admin-2", roles: ["member", "platform_admin", "billing"] },
      tenantId: "t-1",
    });
    const result = await caller.adminOnly();
    expect(result).toBe("ok");
  });
});
