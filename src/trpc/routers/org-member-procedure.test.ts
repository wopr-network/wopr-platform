import { TRPCError } from "@trpc/server";
import { orgMemberProcedure, router, setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { IOrgMemberRepository, OrgMemberRow } from "../../fleet/org-member-repository.js";

function makeMockOrgMemberRepo(members: OrgMemberRow[] = []): IOrgMemberRepository {
  return {
    findMember: vi.fn().mockImplementation(async (orgId: string, userId: string) => {
      return members.find((m) => m.orgId === orgId && m.userId === userId) ?? null;
    }),
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
  } as IOrgMemberRepository;
}

const testRouter = router({
  doSomething: orgMemberProcedure
    .input(z.object({ orgId: z.string(), value: z.string() }))
    .mutation(({ input }) => ({ ok: true, orgId: input.orgId })),
});

describe("orgMemberProcedure", () => {
  const MEMBER: OrgMemberRow = {
    id: "m1",
    orgId: "org-1",
    userId: "user-1",
    role: "member",
    joinedAt: Date.now(),
  };

  beforeEach(() => {
    setTrpcOrgMemberRepo(makeMockOrgMemberRepo([MEMBER]));
  });

  it("allows org members through", async () => {
    const caller = testRouter.createCaller({ user: { id: "user-1", roles: [] }, tenantId: undefined });
    const result = await caller.doSomething({ orgId: "org-1", value: "test" });
    expect(result).toEqual({ ok: true, orgId: "org-1" });
  });

  it("rejects non-members with FORBIDDEN", async () => {
    const caller = testRouter.createCaller({ user: { id: "attacker", roles: [] }, tenantId: undefined });
    await expect(caller.doSomething({ orgId: "org-1", value: "test" })).rejects.toThrow(TRPCError);
    await expect(caller.doSomething({ orgId: "org-1", value: "test" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects unauthenticated users with UNAUTHORIZED", async () => {
    const caller = testRouter.createCaller({ user: undefined, tenantId: undefined });
    await expect(caller.doSomething({ orgId: "org-1", value: "test" })).rejects.toThrow(TRPCError);
    await expect(caller.doSomething({ orgId: "org-1", value: "test" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects empty orgId with BAD_REQUEST", async () => {
    const caller = testRouter.createCaller({ user: { id: "user-1", roles: [] }, tenantId: undefined });
    await expect(caller.doSomething({ orgId: "", value: "test" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("throws INTERNAL_SERVER_ERROR when repo not wired", async () => {
    setTrpcOrgMemberRepo(null as unknown as IOrgMemberRepository);
    const caller = testRouter.createCaller({ user: { id: "user-1", roles: [] }, tenantId: undefined });
    await expect(caller.doSomething({ orgId: "org-1", value: "test" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});
