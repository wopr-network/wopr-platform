import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../fleet/services.js", () => ({
  getAdminAuditLog: vi.fn().mockReturnValue({ log: vi.fn() }),
}));

import { RoleStore } from "../../admin/roles/role-store.js";
import type { AuthEnv } from "../../auth/index.js";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { createAdminRolesRoutes, createPlatformAdminRoutes } from "./admin-roles.js";

/**
 * Wrap a Hono sub-app with a middleware that injects a fake user,
 * mirroring the pattern in activity.test.ts.
 */
function makeRolesApp(db: DrizzleDb, userId = "admin-user") {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: userId, roles: ["user"] });
    return next();
  });
  app.route("/", createAdminRolesRoutes(db));
  return app;
}

function makePlatformAdminApp(db: DrizzleDb, userId = "platform-admin") {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: userId, roles: ["user"] });
    return next();
  });
  app.route("/", createPlatformAdminRoutes(db));
  return app;
}

describe("admin-roles routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let roleStore: RoleStore;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    roleStore = new RoleStore(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  // GET /:tenantId — requires tenant_admin or platform_admin role

  describe("GET /:tenantId", () => {
    it("returns empty roles list for tenant with no roles", async () => {
      // Set up the requesting user as tenant_admin for tenant-a
      await roleStore.setRole("admin-user", "tenant-a", "tenant_admin", "system");
      const app = makeRolesApp(db, "admin-user");

      const res = await app.request("/tenant-a");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("roles");
    });

    it("returns 403 if user is not tenant_admin or platform_admin", async () => {
      // user has no role for tenant-a
      const app = makeRolesApp(db, "regular-user");
      const res = await app.request("/tenant-a");
      expect(res.status).toBe(403);
    });

    it("platform_admin can list any tenant roles", async () => {
      await roleStore.setRole("platform-admin", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makeRolesApp(db, "platform-admin");

      const res = await app.request("/any-tenant");
      expect(res.status).toBe(200);
    });
  });

  // PUT /:tenantId/:userId — set role

  describe("PUT /:tenantId/:userId", () => {
    it("sets tenant_admin role when acting as tenant_admin", async () => {
      await roleStore.setRole("admin-user", "tenant-a", "tenant_admin", "system");
      const app = makeRolesApp(db, "admin-user");

      const res = await app.request("/tenant-a/user-xyz", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 400 for invalid role", async () => {
      await roleStore.setRole("admin-user", "tenant-a", "tenant_admin", "system");
      const app = makeRolesApp(db, "admin-user");

      const res = await app.request("/tenant-a/user-xyz", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "superuser" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/invalid role/i);
    });

    it("returns 403 when non-platform-admin tries to grant platform_admin role", async () => {
      await roleStore.setRole("admin-user", "tenant-a", "tenant_admin", "system");
      const app = makeRolesApp(db, "admin-user");

      const res = await app.request("/tenant-a/user-xyz", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "platform_admin" }),
      });
      expect(res.status).toBe(403);
    });

    it("platform_admin can grant platform_admin role", async () => {
      await roleStore.setRole("platform-admin", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makeRolesApp(db, "platform-admin");

      const res = await app.request("/tenant-a/new-admin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "platform_admin" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // DELETE /:tenantId/:userId — remove role

  describe("DELETE /:tenantId/:userId", () => {
    it("removes a role and returns ok", async () => {
      await roleStore.setRole("admin-user", "tenant-a", "tenant_admin", "system");
      // Target user to remove
      await roleStore.setRole("user-to-remove", "tenant-a", "user", "system");
      const app = makeRolesApp(db, "admin-user");

      const res = await app.request("/tenant-a/user-to-remove", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 404 when role does not exist", async () => {
      await roleStore.setRole("admin-user", "tenant-a", "tenant_admin", "system");
      const app = makeRolesApp(db, "admin-user");

      const res = await app.request("/tenant-a/nonexistent-user", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});

describe("platform admin routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let roleStore: RoleStore;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    roleStore = new RoleStore(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  // GET / — list platform admins

  describe("GET /", () => {
    it("lists platform admins", async () => {
      await roleStore.setRole("platform-admin", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makePlatformAdminApp(db, "platform-admin");

      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("admins");
    });

    it("returns 403 if user is not platform_admin", async () => {
      const app = makePlatformAdminApp(db, "regular-user");
      const res = await app.request("/");
      expect(res.status).toBe(403);
    });
  });

  // POST / — add platform admin

  describe("POST /", () => {
    it("adds a platform admin", async () => {
      await roleStore.setRole("platform-admin", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makePlatformAdminApp(db, "platform-admin");

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "new-platform-admin" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 400 when userId is missing", async () => {
      await roleStore.setRole("platform-admin", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makePlatformAdminApp(db, "platform-admin");

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // DELETE /:userId — remove platform admin

  describe("DELETE /:userId", () => {
    it("returns 409 when removing the last platform admin", async () => {
      await roleStore.setRole("only-admin", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makePlatformAdminApp(db, "only-admin");

      const res = await app.request("/only-admin", {
        method: "DELETE",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/last platform admin/i);
    });

    it("removes a platform admin when multiple exist", async () => {
      await roleStore.setRole("admin-one", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      await roleStore.setRole("admin-two", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makePlatformAdminApp(db, "admin-one");

      const res = await app.request("/admin-two", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 404 when user is not a platform admin", async () => {
      await roleStore.setRole("platform-admin", RoleStore.PLATFORM_TENANT, "platform_admin", "system");
      const app = makePlatformAdminApp(db, "platform-admin");

      const res = await app.request("/nonexistent-admin", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
