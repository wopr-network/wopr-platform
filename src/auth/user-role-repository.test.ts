import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleUserRoleRepository } from "./user-role-repository.js";

describe("DrizzleUserRoleRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleUserRoleRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleUserRoleRepository(db);
  });

  describe("grantRole", () => {
    it("assigns a role and subsequent lookup returns it", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", "admin-1");
      const roles = await repo.listRolesByUser("user-1");
      expect(roles).toHaveLength(1);
      expect(roles[0]).toEqual({ tenantId: "tenant-1", role: "user" });
    });
  });

  describe("revokeRole", () => {
    it("removes a granted role so it is no longer returned", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", "admin-1");
      const removed = await repo.revokeRole("user-1", "tenant-1");
      expect(removed).toBe(true);
      const roles = await repo.listRolesByUser("user-1");
      expect(roles).toHaveLength(0);
    });

    it("returns false when revoking a non-existent role", async () => {
      const removed = await repo.revokeRole("user-1", "tenant-1");
      expect(removed).toBe(false);
    });
  });

  describe("listRolesByUser", () => {
    it("returns only the specified user's roles across tenants", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", null);
      await repo.grantRole("user-1", "tenant-2", "tenant_admin", null);
      await repo.grantRole("user-2", "tenant-1", "user", null);

      const roles = await repo.listRolesByUser("user-1");
      expect(roles).toHaveLength(2);
      const tenantIds = roles.map((r) => r.tenantId).sort();
      expect(tenantIds).toEqual(["tenant-1", "tenant-2"]);
    });

    it("returns empty array for user with no roles", async () => {
      const roles = await repo.listRolesByUser("nobody");
      expect(roles).toEqual([]);
    });
  });

  describe("listUsersByRole", () => {
    it("returns all users with a given role in a tenant", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", null);
      await repo.grantRole("user-2", "tenant-1", "user", null);
      await repo.grantRole("user-3", "tenant-1", "tenant_admin", null);

      const users = await repo.listUsersByRole("user", "tenant-1");
      expect(users).toHaveLength(2);
      const userIds = users.map((u) => u.userId).sort();
      expect(userIds).toEqual(["user-1", "user-2"]);
    });

    it("does not return users from other tenants", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", null);
      await repo.grantRole("user-2", "tenant-2", "user", null);

      const users = await repo.listUsersByRole("user", "tenant-1");
      expect(users).toHaveLength(1);
      expect(users[0].userId).toBe("user-1");
    });
  });

  describe("isPlatformAdmin", () => {
    it("returns true for a user with platform_admin role in sentinel tenant", async () => {
      await repo.grantRole("admin-1", "*", "platform_admin", null);
      expect(await repo.isPlatformAdmin("admin-1")).toBe(true);
    });

    it("returns false for a user with no roles", async () => {
      expect(await repo.isPlatformAdmin("nobody")).toBe(false);
    });

    it("returns false for a tenant_admin in the sentinel tenant", async () => {
      await repo.grantRole("user-1", "*", "tenant_admin", null);
      expect(await repo.isPlatformAdmin("user-1")).toBe(false);
    });

    it("returns false for a platform_admin in a regular tenant", async () => {
      await repo.grantRole("user-1", "tenant-1", "platform_admin", null);
      expect(await repo.isPlatformAdmin("user-1")).toBe(false);
    });
  });

  describe("idempotent grant", () => {
    it("granting the same role twice does not error or duplicate", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", "admin-1");
      await repo.grantRole("user-1", "tenant-1", "user", "admin-1");

      const roles = await repo.listRolesByUser("user-1");
      expect(roles).toHaveLength(1);
    });

    it("granting a different role to same user+tenant upserts", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", "admin-1");
      await repo.grantRole("user-1", "tenant-1", "tenant_admin", "admin-2");

      const roles = await repo.listRolesByUser("user-1");
      expect(roles).toHaveLength(1);
      expect(roles[0].role).toBe("tenant_admin");
    });
  });

  describe("getTenantIdByUserId", () => {
    it("returns the tenant ID for a user with a role", async () => {
      await repo.grantRole("user-1", "tenant-1", "user", null);
      const tenantId = await repo.getTenantIdByUserId("user-1");
      expect(tenantId).toBe("tenant-1");
    });

    it("returns null for a user with no roles", async () => {
      const tenantId = await repo.getTenantIdByUserId("nobody");
      expect(tenantId).toBeNull();
    });

    it("excludes platform admin sentinel tenant", async () => {
      await repo.grantRole("admin-1", "*", "platform_admin", null);
      const tenantId = await repo.getTenantIdByUserId("admin-1");
      expect(tenantId).toBeNull();
    });
  });
});
