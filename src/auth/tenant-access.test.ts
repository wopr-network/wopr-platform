import { describe, expect, it, vi } from "vitest";
import type { IOrgMemberRepository } from "../fleet/org-member-repository.js";
import { validateTenantAccess } from "./index.js";

function mockOrgMemberRepo(overrides: Partial<IOrgMemberRepository> = {}): IOrgMemberRepository {
  return {
    listMembers: vi.fn().mockResolvedValue([]),
    addMember: vi.fn().mockResolvedValue(undefined),
    updateMemberRole: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    findMember: vi.fn().mockResolvedValue(null),
    countAdminsAndOwners: vi.fn().mockResolvedValue(0),
    listInvites: vi.fn().mockResolvedValue([]),
    createInvite: vi.fn().mockResolvedValue(undefined),
    findInviteById: vi.fn().mockResolvedValue(null),
    findInviteByToken: vi.fn().mockResolvedValue(null),
    deleteInvite: vi.fn().mockResolvedValue(undefined),
    deleteAllMembers: vi.fn().mockResolvedValue(undefined),
    deleteAllInvites: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("validateTenantAccess", () => {
  it("allows access when requestedTenantId matches userId (personal tenant)", async () => {
    const repo = mockOrgMemberRepo();
    const result = await validateTenantAccess("user-1", "user-1", repo);
    expect(result).toBe(true);
    expect(repo.findMember).not.toHaveBeenCalled();
  });

  it("allows access when user is a member of the requested org", async () => {
    const repo = mockOrgMemberRepo({
      findMember: vi.fn().mockResolvedValue({
        id: "m1",
        orgId: "org-1",
        userId: "user-1",
        role: "member",
        joinedAt: 0,
      }),
    });
    const result = await validateTenantAccess("user-1", "org-1", repo);
    expect(result).toBe(true);
    expect(repo.findMember).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("denies access when user is NOT a member of the requested org", async () => {
    const repo = mockOrgMemberRepo({
      findMember: vi.fn().mockResolvedValue(null),
    });
    const result = await validateTenantAccess("user-1", "org-evil", repo);
    expect(result).toBe(false);
    expect(repo.findMember).toHaveBeenCalledWith("org-evil", "user-1");
  });

  it("allows access when requestedTenantId is undefined (falls back to personal)", async () => {
    const repo = mockOrgMemberRepo();
    const result = await validateTenantAccess("user-1", undefined, repo);
    expect(result).toBe(true);
    expect(repo.findMember).not.toHaveBeenCalled();
  });

  it("allows access when requestedTenantId is empty string (falls back to personal)", async () => {
    const repo = mockOrgMemberRepo();
    const result = await validateTenantAccess("user-1", "", repo);
    expect(result).toBe(true);
    expect(repo.findMember).not.toHaveBeenCalled();
  });
});
