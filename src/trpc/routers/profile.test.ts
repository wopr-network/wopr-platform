import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import type { TRPCContext } from "@wopr-network/platform-core/trpc";
import { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  } as IOrgMemberRepository);
});

import { appRouter } from "../index.js";
import { setProfileRouterDeps } from "./profile.js";

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

describe("tRPC profile router", () => {
  const mockGetUser = vi.fn();
  const mockUpdateUser = vi.fn();
  const mockChangePassword = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      id: "test-user",
      name: "Test User",
      email: "test@example.com",
      image: null,
      twoFactorEnabled: false,
    });
    mockUpdateUser.mockImplementation((_id: string, data: Record<string, unknown>) =>
      Promise.resolve({
        id: "test-user",
        name: data.name ?? "Test User",
        email: "test@example.com",
        image: data.image ?? null,
        twoFactorEnabled: false,
      }),
    );
    mockChangePassword.mockResolvedValue(true);
    setProfileRouterDeps({
      getUser: mockGetUser,
      updateUser: mockUpdateUser,
      changePassword: mockChangePassword,
    });
  });

  describe("getProfile", () => {
    it("returns user profile", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.profile.getProfile();
      expect(result).toHaveProperty("id", "test-user");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("email");
      expect(mockGetUser).toHaveBeenCalledWith("test-user");
    });

    it("returns twoFactorEnabled: false when 2FA is not enabled", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.profile.getProfile();
      expect(result.twoFactorEnabled).toBe(false);
    });

    it("returns twoFactorEnabled: true when 2FA is enabled", async () => {
      mockGetUser.mockResolvedValue({
        id: "test-user",
        name: "Test User",
        email: "test@example.com",
        image: null,
        twoFactorEnabled: true,
      });
      const caller = createCaller(authedContext());
      const result = await caller.profile.getProfile();
      expect(result.twoFactorEnabled).toBe(true);
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.profile.getProfile()).rejects.toThrow("Authentication required");
    });
  });

  describe("updateProfile", () => {
    it("updates display name", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.profile.updateProfile({ name: "New Name" });
      expect(result.name).toBe("New Name");
      expect(mockUpdateUser).toHaveBeenCalledWith("test-user", { name: "New Name" });
    });

    it("includes twoFactorEnabled in update response", async () => {
      mockUpdateUser.mockResolvedValue({
        id: "test-user",
        name: "New Name",
        email: "test@example.com",
        image: null,
        twoFactorEnabled: true,
      });
      const caller = createCaller(authedContext());
      const result = await caller.profile.updateProfile({ name: "New Name" });
      expect(result.twoFactorEnabled).toBe(true);
    });

    it("updates avatar URL", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.profile.updateProfile({ image: "https://example.com/avatar.png" });
      expect(result.image).toBe("https://example.com/avatar.png");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.profile.updateProfile({ name: "X" })).rejects.toThrow("Authentication required");
    });
  });

  describe("changePassword", () => {
    it("changes password with valid old password", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.profile.changePassword({
        currentPassword: "old-pass",
        newPassword: "new-pass-12345",
      });
      expect(result.ok).toBe(true);
      expect(mockChangePassword).toHaveBeenCalledWith("test-user", "old-pass", "new-pass-12345");
    });

    it("rejects when old password is wrong", async () => {
      mockChangePassword.mockResolvedValue(false);
      const caller = createCaller(authedContext());
      await expect(
        caller.profile.changePassword({ currentPassword: "wrong", newPassword: "new-pass-12345" }),
      ).rejects.toThrow();
    });

    it("rejects short new password", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.profile.changePassword({ currentPassword: "old", newPassword: "short" })).rejects.toThrow();
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(
        caller.profile.changePassword({ currentPassword: "a", newPassword: "b".repeat(10) }),
      ).rejects.toThrow("Authentication required");
    });
  });
});
