import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { userRoles } from "../../db/schema/user-roles.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { isValidRole, RoleStore } from "./role-store.js";

describe("isValidRole", () => {
  it("accepts valid roles", () => {
    expect(isValidRole("platform_admin")).toBe(true);
    expect(isValidRole("tenant_admin")).toBe(true);
    expect(isValidRole("user")).toBe(true);
  });

  it("rejects invalid roles", () => {
    expect(isValidRole("admin")).toBe(false);
    expect(isValidRole("superuser")).toBe(false);
    expect(isValidRole("")).toBe(false);
  });
});

describe("RoleStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: RoleStore;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new RoleStore(db);
  });

  describe("setRole / getRole", () => {
    it("sets and gets a role", async () => {
      await store.setRole("user-1", "tenant-1", "user", "admin-1");
      expect(await store.getRole("user-1", "tenant-1")).toBe("user");
    });

    it("returns null for non-existent role", async () => {
      expect(await store.getRole("user-1", "tenant-1")).toBeNull();
    });

    it("upserts an existing role", async () => {
      await store.setRole("user-1", "tenant-1", "user", "admin-1");
      await store.setRole("user-1", "tenant-1", "tenant_admin", "admin-2");
      expect(await store.getRole("user-1", "tenant-1")).toBe("tenant_admin");
    });

    it("stores granted_by and granted_at", async () => {
      await store.setRole("user-1", "tenant-1", "user", "admin-1");
      const rows = await db
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, "user-1"), eq(userRoles.tenantId, "tenant-1")));
      expect(rows[0].grantedBy).toBe("admin-1");
      expect(rows[0].grantedAt).toBeGreaterThan(0);
    });

    it("handles null granted_by", async () => {
      await store.setRole("user-1", "tenant-1", "user", null);
      const rows = await db
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, "user-1"), eq(userRoles.tenantId, "tenant-1")));
      expect(rows[0].grantedBy).toBeNull();
    });

    it("rejects invalid roles", async () => {
      await expect(() => store.setRole("user-1", "tenant-1", "superuser" as "user", "admin-1")).rejects.toThrow(
        "Invalid role",
      );
    });

    it("allows same user in different tenants", async () => {
      await store.setRole("user-1", "tenant-1", "user", "admin-1");
      await store.setRole("user-1", "tenant-2", "tenant_admin", "admin-1");
      expect(await store.getRole("user-1", "tenant-1")).toBe("user");
      expect(await store.getRole("user-1", "tenant-2")).toBe("tenant_admin");
    });
  });

  describe("removeRole", () => {
    it("removes an existing role", async () => {
      await store.setRole("user-1", "tenant-1", "user", "admin-1");
      expect(await store.removeRole("user-1", "tenant-1")).toBe(true);
      expect(await store.getRole("user-1", "tenant-1")).toBeNull();
    });

    it("returns false for non-existent role", async () => {
      expect(await store.removeRole("user-1", "tenant-1")).toBe(false);
    });
  });

  describe("listByTenant", () => {
    it("lists all users in a tenant", async () => {
      await store.setRole("user-1", "tenant-1", "user", "admin-1");
      await store.setRole("user-2", "tenant-1", "tenant_admin", "admin-1");
      await store.setRole("user-3", "tenant-2", "user", "admin-1");

      const roles = await store.listByTenant("tenant-1");
      expect(roles).toHaveLength(2);
      expect(roles.map((r) => r.user_id).sort()).toEqual(["user-1", "user-2"]);
    });

    it("returns empty array for tenant with no roles", async () => {
      const roles = await store.listByTenant("nonexistent");
      expect(roles).toHaveLength(0);
    });
  });

  describe("platform admin operations", () => {
    it("isPlatformAdmin returns true for platform admins", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      expect(await store.isPlatformAdmin("admin-1")).toBe(true);
    });

    it("isPlatformAdmin returns false for non-admins", async () => {
      expect(await store.isPlatformAdmin("user-1")).toBe(false);
    });

    it("isPlatformAdmin returns false for tenant_admin", async () => {
      await store.setRole("user-1", RoleStore.PLATFORM_TENANT, "tenant_admin", null);
      expect(await store.isPlatformAdmin("user-1")).toBe(false);
    });

    it("listPlatformAdmins returns all platform admins", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      await store.setRole("admin-2", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      await store.setRole("user-1", "tenant-1", "user", "admin-1");

      const admins = await store.listPlatformAdmins();
      expect(admins).toHaveLength(2);
      expect(admins.map((a) => a.user_id).sort()).toEqual(["admin-1", "admin-2"]);
    });

    it("countPlatformAdmins returns correct count", async () => {
      expect(await store.countPlatformAdmins()).toBe(0);
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      expect(await store.countPlatformAdmins()).toBe(1);
      await store.setRole("admin-2", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      expect(await store.countPlatformAdmins()).toBe(2);
    });
  });
});
