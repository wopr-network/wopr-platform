import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdminRolesRoutes, createPlatformAdminRoutes } from "../../api/routes/admin-roles.js";
import type { AuthEnv, AuthUser } from "../../auth/index.js";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { requirePlatformAdmin, requireTenantAdmin } from "./require-role.js";
import { RoleStore } from "./role-store.js";

/** Helper to create a Hono app with a fake user injected. */
function appWithUser(user: AuthUser | null) {
  const app = new Hono<AuthEnv>();
  if (user) {
    app.use("*", async (c, next) => {
      c.set("user", user);
      c.set("authMethod", "session");
      return next();
    });
  }
  return app;
}

describe("requirePlatformAdmin middleware", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: RoleStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    store = new RoleStore(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("allows platform admins", async () => {
    await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

    const app = appWithUser({ id: "admin-1", roles: [] });
    app.get("/test", requirePlatformAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects non-platform-admins", async () => {
    await store.setRole("user-1", "tenant-1", "user", null);

    const app = appWithUser({ id: "user-1", roles: [] });
    app.get("/test", requirePlatformAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const app = new Hono<AuthEnv>();
    app.get("/test", requirePlatformAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });
});

describe("requireTenantAdmin middleware", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: RoleStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    store = new RoleStore(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("allows platform admins for any tenant", async () => {
    await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

    const app = appWithUser({ id: "admin-1", roles: [] });
    app.get("/tenants/:tenantId", requireTenantAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/tenants/any-tenant");
    expect(res.status).toBe(200);
  });

  it("allows tenant admins for their own tenant", async () => {
    await store.setRole("user-1", "tenant-1", "tenant_admin", null);

    const app = appWithUser({ id: "user-1", roles: [] });
    app.get("/tenants/:tenantId", requireTenantAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/tenants/tenant-1");
    expect(res.status).toBe(200);
  });

  it("rejects tenant admins for other tenants", async () => {
    await store.setRole("user-1", "tenant-1", "tenant_admin", null);

    const app = appWithUser({ id: "user-1", roles: [] });
    app.get("/tenants/:tenantId", requireTenantAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/tenants/tenant-2");
    expect(res.status).toBe(403);
  });

  it("rejects regular users", async () => {
    await store.setRole("user-1", "tenant-1", "user", null);

    const app = appWithUser({ id: "user-1", roles: [] });
    app.get("/tenants/:tenantId", requireTenantAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/tenants/tenant-1");
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const app = new Hono<AuthEnv>();
    app.get("/tenants/:tenantId", requireTenantAdmin(store), (c) => c.json({ ok: true }));

    const res = await app.request("/tenants/tenant-1");
    expect(res.status).toBe(401);
  });
});

describe("admin roles API routes", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: RoleStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    store = new RoleStore(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  function buildApp(userId: string) {
    const app = appWithUser({ id: userId, roles: [] });
    app.route("/api/admin/roles", createAdminRolesRoutes(db));
    app.route("/api/admin/platform-admins", createPlatformAdminRoutes(db));
    return app;
  }

  describe("GET /api/admin/roles/:tenantId", () => {
    it("platform admin can list roles for any tenant", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      await store.setRole("user-1", "tenant-1", "user", "admin-1");
      await store.setRole("user-2", "tenant-1", "tenant_admin", "admin-1");

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/roles/tenant-1");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.roles).toHaveLength(2);
    });

    it("tenant admin can list roles for their own tenant", async () => {
      await store.setRole("ta-1", "tenant-1", "tenant_admin", null);
      await store.setRole("user-1", "tenant-1", "user", "ta-1");

      const app = buildApp("ta-1");
      const res = await app.request("/api/admin/roles/tenant-1");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.roles).toHaveLength(2);
    });

    it("regular user cannot list roles", async () => {
      await store.setRole("user-1", "tenant-1", "user", null);

      const app = buildApp("user-1");
      const res = await app.request("/api/admin/roles/tenant-1");
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/admin/roles/:tenantId/:userId", () => {
    it("platform admin can set role in any tenant", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/roles/tenant-1/user-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user" }),
      });
      expect(res.status).toBe(200);
      expect(await store.getRole("user-1", "tenant-1")).toBe("user");
    });

    it("tenant admin can set role in their own tenant", async () => {
      await store.setRole("ta-1", "tenant-1", "tenant_admin", null);

      const app = buildApp("ta-1");
      const res = await app.request("/api/admin/roles/tenant-1/user-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user" }),
      });
      expect(res.status).toBe(200);
      expect(await store.getRole("user-1", "tenant-1")).toBe("user");
    });

    it("rejects invalid role", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/roles/tenant-1/user-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "superuser" }),
      });
      expect(res.status).toBe(400);
    });

    it("only platform admin can grant platform_admin role", async () => {
      await store.setRole("ta-1", "tenant-1", "tenant_admin", null);

      const app = buildApp("ta-1");
      const res = await app.request("/api/admin/roles/tenant-1/user-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "platform_admin" }),
      });
      expect(res.status).toBe(403);
    });

    it("rejects empty body", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/roles/tenant-1/user-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/admin/roles/:tenantId/:userId", () => {
    it("platform admin can remove role", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      await store.setRole("user-1", "tenant-1", "user", "admin-1");

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/roles/tenant-1/user-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await store.getRole("user-1", "tenant-1")).toBeNull();
    });

    it("returns 404 for non-existent role", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/roles/tenant-1/user-999", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/admin/platform-admins", () => {
    it("lists all platform admins", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      await store.setRole("admin-2", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/platform-admins");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.admins).toHaveLength(2);
    });

    it("rejects non-platform-admins", async () => {
      await store.setRole("user-1", "tenant-1", "user", null);

      const app = buildApp("user-1");
      const res = await app.request("/api/admin/platform-admins");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/admin/platform-admins", () => {
    it("adds a platform admin", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/platform-admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-2" }),
      });
      expect(res.status).toBe(200);
      expect(await store.isPlatformAdmin("user-2")).toBe(true);
    });

    it("rejects missing userId", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/platform-admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/admin/platform-admins/:userId", () => {
    it("removes a platform admin", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);
      await store.setRole("admin-2", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/platform-admins/admin-2", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await store.isPlatformAdmin("admin-2")).toBe(false);
    });

    it("prevents removing the last platform admin", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/platform-admins/admin-1", { method: "DELETE" });
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error).toContain("last platform admin");
    });

    it("returns 404 for non-existent platform admin", async () => {
      await store.setRole("admin-1", RoleStore.PLATFORM_TENANT, "platform_admin", null);

      const app = buildApp("admin-1");
      const res = await app.request("/api/admin/platform-admins/user-999", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
