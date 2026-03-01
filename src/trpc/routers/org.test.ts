import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAuthUserRepository, LinkedAccount } from "../../db/auth-user-repository.js";
import type { OrgService } from "../../org/org-service.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
import { setOrgRouterDeps } from "./org.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authedContext(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    user: { id: "test-user", roles: ["admin"] },
    tenantId: "test-tenant",
    ...overrides,
  };
}

function unauthContext(): TRPCContext {
  return { user: undefined, tenantId: undefined };
}

function createCaller(ctx: TRPCContext) {
  return appRouter.createCaller(ctx);
}

const MOCK_ORG = {
  id: "org-1",
  name: "Test Org",
  slug: "test-org",
  type: "personal" as const,
  ownerId: "test-user",
  createdAt: Date.now(),
  members: [
    {
      id: "m1",
      userId: "test-user",
      name: "Test User",
      email: "test@example.com",
      role: "owner" as const,
      joinedAt: new Date().toISOString(),
    },
  ],
  invites: [],
};

function makeMockOrgService(): OrgService {
  return {
    getOrCreatePersonalOrg: vi.fn().mockReturnValue(MOCK_ORG),
    updateOrg: vi.fn().mockReturnValue(MOCK_ORG),
    deleteOrg: vi.fn(),
    createOrg: vi.fn().mockResolvedValue({ id: "org-new", name: "New Org", slug: "new-org" }),
    inviteMember: vi.fn().mockResolvedValue({
      id: "inv-1",
      orgId: "org-1",
      email: "new@example.com",
      role: "member",
      invitedBy: "test-user",
      token: "tok",
      expiresAt: Date.now() + 86400000,
      createdAt: Date.now(),
    }),
    revokeInvite: vi.fn(),
    changeRole: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn(),
    validateSlug: vi.fn(),
    getOrg: vi.fn(),
  } as unknown as OrgService;
}

function makeMockAuthUserRepo(accounts: LinkedAccount[] = []): IAuthUserRepository {
  const accts = [...accounts];
  return {
    getUser: vi.fn().mockResolvedValue(null),
    updateUser: vi.fn().mockResolvedValue({ id: "test-user", name: "Test", email: "test@example.com", image: null }),
    changePassword: vi.fn().mockResolvedValue(true),
    listAccounts: vi.fn().mockImplementation(async () => [...accts]),
    unlinkAccount: vi.fn().mockImplementation(async (_userId: string, providerId: string) => {
      const idx = accts.findIndex((a) => a.providerId === providerId);
      if (idx >= 0) {
        accts.splice(idx, 1);
        return true;
      }
      return false;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tRPC org router", () => {
  let mockOrgService: OrgService;
  let mockAuthUserRepo: IAuthUserRepository;

  beforeEach(() => {
    mockOrgService = makeMockOrgService();
    mockAuthUserRepo = makeMockAuthUserRepo([
      { id: "a1", providerId: "credential", accountId: "test-user" },
      { id: "a2", providerId: "github", accountId: "gh-123" },
    ]);
    setOrgRouterDeps({ orgService: mockOrgService, authUserRepo: mockAuthUserRepo });
  });

  // ---- getOrganization ----

  describe("getOrganization", () => {
    it("returns organization for authenticated user", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.getOrganization();
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("members");
      expect(result).toHaveProperty("invites");
      expect(Array.isArray(result.members)).toBe(true);
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.getOrganization()).rejects.toThrow("Authentication required");
    });
  });

  // ---- updateOrganization ----

  describe("updateOrganization", () => {
    it("updates org name", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.updateOrganization({ orgId: "org-1", name: "New Org Name" });
      expect(mockOrgService.updateOrg).toHaveBeenCalledWith("org-1", "test-user", {
        name: "New Org Name",
        slug: undefined,
        billingEmail: undefined,
      });
      expect(result).toBeDefined();
    });

    it("passes billingEmail to orgService.updateOrg", async () => {
      const caller = createCaller(authedContext());
      await caller.org.updateOrganization({ orgId: "org-1", billingEmail: "billing@test.com" });
      expect(mockOrgService.updateOrg).toHaveBeenCalledWith("org-1", "test-user", {
        name: undefined,
        slug: undefined,
        billingEmail: "billing@test.com",
      });
    });

    it("rejects invalid billingEmail format", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.org.updateOrganization({ orgId: "org-1", billingEmail: "not-an-email" })).rejects.toThrow();
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.updateOrganization({ orgId: "org-1", name: "X" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // ---- inviteMember ----

  describe("inviteMember", () => {
    it("returns new invite with correct email and role", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.inviteMember({ orgId: "org-1", email: "new@example.com", role: "member" });
      expect(result.email).toBe("new@example.com");
      expect(result.role).toBe("member");
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("expiresAt");
    });

    it("accepts admin role", async () => {
      vi.mocked(mockOrgService.inviteMember).mockResolvedValue({
        id: "inv-2",
        orgId: "org-1",
        email: "admin@example.com",
        role: "admin",
        invitedBy: "test-user",
        token: "tok2",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      });
      const caller = createCaller(authedContext());
      const result = await caller.org.inviteMember({ orgId: "org-1", email: "admin@example.com", role: "admin" });
      expect(result.role).toBe("admin");
    });

    it("rejects invalid role", async () => {
      const caller = createCaller(authedContext());
      await expect(
        caller.org.inviteMember({ orgId: "org-1", email: "a@b.com", role: "owner" as "admin" }),
      ).rejects.toThrow();
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.inviteMember({ orgId: "org-1", email: "a@b.com", role: "member" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // ---- revokeInvite ----

  describe("revokeInvite", () => {
    it("revokes an invite", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.revokeInvite({ orgId: "org-1", inviteId: "inv-1" });
      expect(result.revoked).toBe(true);
      expect(mockOrgService.revokeInvite).toHaveBeenCalledWith("org-1", "test-user", "inv-1");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.revokeInvite({ orgId: "org-1", inviteId: "inv-1" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // ---- changeRole ----

  describe("changeRole", () => {
    it("changes a member's role", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.changeRole({ orgId: "org-1", userId: "user-2", role: "admin" });
      expect(result.updated).toBe(true);
      expect(mockOrgService.changeRole).toHaveBeenCalledWith("org-1", "test-user", "user-2", "admin");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.changeRole({ orgId: "org-1", userId: "u2", role: "admin" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // ---- removeMember ----

  describe("removeMember", () => {
    it("returns removal confirmation", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.removeMember({ orgId: "org-1", userId: "member-123" });
      expect(result.removed).toBe(true);
      expect(mockOrgService.removeMember).toHaveBeenCalledWith("org-1", "test-user", "member-123");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.removeMember({ orgId: "org-1", userId: "m1" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // ---- transferOwnership ----

  describe("transferOwnership", () => {
    it("returns transfer confirmation", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.transferOwnership({ orgId: "org-1", userId: "member-456" });
      expect(result.transferred).toBe(true);
      expect(mockOrgService.transferOwnership).toHaveBeenCalledWith("org-1", "test-user", "member-456");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.transferOwnership({ orgId: "org-1", userId: "m1" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // ---- connectOauthProvider ----

  describe("connectOauthProvider", () => {
    it("returns OAuth URL for a supported provider", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.connectOauthProvider({ provider: "github" });
      expect(result.url).toContain("/api/auth/sign-in/social");
      expect(result.url).toContain("provider=github");
      expect(result.provider).toBe("github");
    });

    it("returns OAuth URL for discord", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.connectOauthProvider({ provider: "discord" });
      expect(result.url).toContain("provider=discord");
      expect(result.provider).toBe("discord");
    });

    it("rejects unsupported providers", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.org.connectOauthProvider({ provider: "facebook" })).rejects.toThrow(/Unsupported OAuth/);
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.connectOauthProvider({ provider: "github" })).rejects.toThrow("Authentication required");
    });
  });

  // ---- createOrganization ----

  describe("createOrganization", () => {
    it("creates an organization with name and slug", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.createOrganization({ name: "New Org", slug: "new-org" });
      expect(result).toEqual({ id: "org-new", name: "New Org", slug: "new-org" });
      expect(mockOrgService.createOrg).toHaveBeenCalledWith("test-user", "New Org", "new-org");
    });

    it("creates an organization with name only (slug auto-generated)", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.createOrganization({ name: "My Team" });
      expect(result).toEqual({ id: "org-new", name: "New Org", slug: "new-org" });
      expect(mockOrgService.createOrg).toHaveBeenCalledWith("test-user", "My Team", undefined);
    });

    it("rejects empty name", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.org.createOrganization({ name: "" })).rejects.toThrow();
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.createOrganization({ name: "X" })).rejects.toThrow("Authentication required");
    });
  });

  // ---- disconnectOauthProvider ----

  describe("disconnectOauthProvider", () => {
    it("disconnects a linked provider when user has multiple accounts", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.disconnectOauthProvider({ provider: "github" });
      expect(result.disconnected).toBe(true);
      expect(result.provider).toBe("github");
    });

    it("throws NOT_FOUND when provider is not linked", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.org.disconnectOauthProvider({ provider: "google" })).rejects.toThrow(/not linked/);
    });

    it("prevents disconnecting the last authentication method", async () => {
      // Override to have only one account
      mockAuthUserRepo = makeMockAuthUserRepo([{ id: "a1", providerId: "github", accountId: "gh-123" }]);
      setOrgRouterDeps({ orgService: mockOrgService, authUserRepo: mockAuthUserRepo });
      const caller = createCaller(authedContext());
      await expect(caller.org.disconnectOauthProvider({ provider: "github" })).rejects.toThrow(
        /Cannot disconnect your only authentication method/,
      );
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.disconnectOauthProvider({ provider: "github" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });
});
