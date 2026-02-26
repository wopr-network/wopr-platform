/**
 * Tests for WOP-832: 2FA mandate tRPC router and schema.
 *
 * Verifies getMandateStatus and setMandateStatus procedures,
 * including admin guard enforcement.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DrizzleTwoFactorRepository } from "../security/two-factor-repository.js";
import { createTestDb } from "../test/db.js";
import { appRouter } from "../trpc/index.js";
import type { TRPCContext } from "../trpc/init.js";
import { setTwoFactorRouterDeps } from "../trpc/routers/two-factor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCaller(ctx: TRPCContext) {
  return appRouter.createCaller(ctx);
}

function adminCtx(tenantId = "t1"): TRPCContext {
  return { user: { id: "admin-user", roles: ["tenant_admin"] }, tenantId };
}

function userCtx(tenantId = "t1"): TRPCContext {
  return { user: { id: "regular-user", roles: ["user"] }, tenantId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("twoFactor tRPC router", () => {
  beforeEach(async () => {
    const { db } = await createTestDb();
    setTwoFactorRouterDeps({ twoFactorRepo: new DrizzleTwoFactorRepository(db) });
  });

  describe("getMandateStatus", () => {
    it("returns false when no row exists for tenant", async () => {
      const caller = createCaller(userCtx("new-tenant"));
      const result = await caller.twoFactor.getMandateStatus();
      expect(result.tenantId).toBe("new-tenant");
      expect(result.requireTwoFactor).toBe(false);
    });

    it("returns the stored mandate status", async () => {
      const { db } = await createTestDb();
      setTwoFactorRouterDeps({ twoFactorRepo: new DrizzleTwoFactorRepository(db) });

      // Set mandate via admin first
      const admin = createCaller(adminCtx("tenant-a"));
      await admin.twoFactor.setMandateStatus({ tenantId: "tenant-a", requireTwoFactor: true });

      // Read back via user
      const user = createCaller(userCtx("tenant-a"));
      const result = await user.twoFactor.getMandateStatus();
      expect(result.requireTwoFactor).toBe(true);
    });
  });

  describe("setMandateStatus", () => {
    it("allows admin to enable 2FA mandate", async () => {
      const caller = createCaller(adminCtx("tenant-b"));
      const result = await caller.twoFactor.setMandateStatus({
        tenantId: "tenant-b",
        requireTwoFactor: true,
      });
      expect(result.tenantId).toBe("tenant-b");
      expect(result.requireTwoFactor).toBe(true);
    });

    it("allows admin to disable 2FA mandate", async () => {
      const caller = createCaller(adminCtx("tenant-c"));
      await caller.twoFactor.setMandateStatus({ tenantId: "tenant-c", requireTwoFactor: true });
      const result = await caller.twoFactor.setMandateStatus({
        tenantId: "tenant-c",
        requireTwoFactor: false,
      });
      expect(result.requireTwoFactor).toBe(false);
    });

    it("upserts on conflict — second call overwrites first", async () => {
      const { db } = await createTestDb();
      setTwoFactorRouterDeps({ twoFactorRepo: new DrizzleTwoFactorRepository(db) });
      const caller = createCaller(adminCtx("tenant-d"));
      await caller.twoFactor.setMandateStatus({ tenantId: "tenant-d", requireTwoFactor: true });
      await caller.twoFactor.setMandateStatus({ tenantId: "tenant-d", requireTwoFactor: false });

      const reader = createCaller(userCtx("tenant-d"));
      const status = await reader.twoFactor.getMandateStatus();
      expect(status.requireTwoFactor).toBe(false);
    });

    it("rejects non-admin user with FORBIDDEN", async () => {
      const caller = createCaller(userCtx("tenant-e"));
      await expect(
        caller.twoFactor.setMandateStatus({ tenantId: "tenant-e", requireTwoFactor: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects unauthenticated call with UNAUTHORIZED", async () => {
      const caller = createCaller({ user: undefined, tenantId: undefined });
      await expect(
        caller.twoFactor.setMandateStatus({ tenantId: "tenant-f", requireTwoFactor: true }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });
});
