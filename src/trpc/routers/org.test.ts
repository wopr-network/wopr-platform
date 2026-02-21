import { beforeEach, describe, expect, it } from "vitest";
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tRPC org router", () => {
  beforeEach(() => {
    setOrgRouterDeps({});
  });

  // ---- getOrganization ----

  describe("getOrganization", () => {
    it("returns organization for authenticated user", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.getOrganization();
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("billingEmail");
      expect(result).toHaveProperty("members");
      expect(Array.isArray(result.members)).toBe(true);
      expect(result.members.length).toBeGreaterThan(0);
      expect(result.members[0]).toHaveProperty("role");
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
      const result = await caller.org.updateOrganization({ name: "New Org Name" });
      expect(result.name).toBe("New Org Name");
    });

    it("updates billing email", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.updateOrganization({ billingEmail: "billing@example.com" });
      expect(result.billingEmail).toBe("billing@example.com");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.updateOrganization({ name: "X" })).rejects.toThrow("Authentication required");
    });

    it("rejects invalid email", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.org.updateOrganization({ billingEmail: "not-an-email" })).rejects.toThrow();
    });
  });

  // ---- inviteMember ----

  describe("inviteMember", () => {
    it("returns new member with correct email and role", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.inviteMember({ email: "new@example.com", role: "viewer" });
      expect(result.email).toBe("new@example.com");
      expect(result.role).toBe("viewer");
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("joinedAt");
    });

    it("accepts admin role", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.inviteMember({ email: "admin@example.com", role: "admin" });
      expect(result.role).toBe("admin");
    });

    it("rejects invalid role", async () => {
      const caller = createCaller(authedContext());
      await expect(caller.org.inviteMember({ email: "a@b.com", role: "owner" as "admin" })).rejects.toThrow();
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.inviteMember({ email: "a@b.com", role: "viewer" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });

  // ---- removeMember ----

  describe("removeMember", () => {
    it("returns removal confirmation", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.removeMember({ memberId: "member-123" });
      expect(result.removed).toBe(true);
      expect(result.memberId).toBe("member-123");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.removeMember({ memberId: "m1" })).rejects.toThrow("Authentication required");
    });
  });

  // ---- transferOwnership ----

  describe("transferOwnership", () => {
    it("returns transfer confirmation", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.transferOwnership({ memberId: "member-456" });
      expect(result.transferred).toBe(true);
      expect(result.newOwnerId).toBe("member-456");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.transferOwnership({ memberId: "m1" })).rejects.toThrow("Authentication required");
    });
  });

  // ---- connectOauthProvider ----

  describe("connectOauthProvider", () => {
    it("returns connection confirmation", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.connectOauthProvider({ provider: "github" });
      expect(result.connected).toBe(true);
      expect(result.provider).toBe("github");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.connectOauthProvider({ provider: "github" })).rejects.toThrow("Authentication required");
    });
  });

  // ---- disconnectOauthProvider ----

  describe("disconnectOauthProvider", () => {
    it("returns disconnection confirmation", async () => {
      const caller = createCaller(authedContext());
      const result = await caller.org.disconnectOauthProvider({ provider: "github" });
      expect(result.disconnected).toBe(true);
      expect(result.provider).toBe("github");
    });

    it("rejects unauthenticated request", async () => {
      const caller = createCaller(unauthContext());
      await expect(caller.org.disconnectOauthProvider({ provider: "github" })).rejects.toThrow(
        "Authentication required",
      );
    });
  });
});
