import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { requirePlatformAdmin, requireTenantAdmin } from "../../admin/roles/require-role.js";
import { initRolesSchema } from "../../admin/roles/schema.js";
import type { AuthEnv } from "../../auth/index.js";
import * as dbSchema from "../../db/schema/index.js";
import { DrizzleRoleRepository, PLATFORM_TENANT } from "../../infrastructure/persistence/drizzle-role-repository.js";

function isValidRole(role: string): boolean {
  return role === "platform_admin" || role === "tenant_admin" || role === "user";
}

/**
 * Create admin role management API routes with an explicit database.
 * Used in tests to inject an in-memory database.
 */
export function createAdminRolesRoutes(db: Database.Database): Hono<AuthEnv> {
  initRolesSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });
  const roleRepo = new DrizzleRoleRepository(drizzleDb);
  const routes = new Hono<AuthEnv>();

  // --- Tenant role routes ---

  // GET /api/admin/roles/:tenantId — list roles for a tenant
  // Platform admins can view any tenant; tenant admins can view their own
  routes.get("/:tenantId", requireTenantAdmin(roleRepo), async (c) => {
    const tenantId = c.req.param("tenantId");
    const roles = await roleRepo.listByTenant(tenantId);
    return c.json({ roles });
  });

  // PUT /api/admin/roles/:tenantId/:userId — set role for user in tenant
  // Platform admins can manage any tenant; tenant admins can manage their own
  routes.put("/:tenantId/:userId", requireTenantAdmin(roleRepo), async (c) => {
    const tenantId = c.req.param("tenantId");
    const userId = c.req.param("userId");
    const body = await c.req.json<{ role: string }>().catch(() => null);

    if (!body?.role || !isValidRole(body.role)) {
      return c.json({ error: "Invalid role. Must be: platform_admin, tenant_admin, or user" }, 400);
    }

    const currentUser = c.get("user");

    // Only platform admins can grant platform_admin role
    if (body.role === "platform_admin" && !(await roleRepo.isPlatformAdmin(currentUser.id))) {
      return c.json({ error: "Only platform admins can grant platform_admin role" }, 403);
    }

    await roleRepo.setRole(userId, tenantId, body.role as "platform_admin" | "tenant_admin" | "user", currentUser.id);

    return c.json({ ok: true });
  });

  // DELETE /api/admin/roles/:tenantId/:userId — remove role
  // Platform admins can manage any tenant; tenant admins can manage their own
  routes.delete("/:tenantId/:userId", requireTenantAdmin(roleRepo), async (c) => {
    const tenantId = c.req.param("tenantId");
    const userId = c.req.param("userId");

    const removed = await roleRepo.removeRole(userId, tenantId);
    if (!removed) {
      return c.json({ error: "Role not found" }, 404);
    }

    return c.json({ ok: true });
  });

  // --- Platform admin routes ---

  // GET /api/admin/roles — list platform admins (no tenantId param)
  // This route is registered as /platform-admins on the parent router
  // but we include the platform admin routes here as a sub-group

  return routes;
}

/**
 * Create platform admin management routes with an explicit database.
 */
export function createPlatformAdminRoutes(db: Database.Database): Hono<AuthEnv> {
  initRolesSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });
  const roleRepo = new DrizzleRoleRepository(drizzleDb);
  const routes = new Hono<AuthEnv>();

  // All platform admin routes require platform_admin role
  routes.use("*", requirePlatformAdmin(roleRepo));

  // GET /api/admin/platform-admins — list all platform admins
  routes.get("/", async (c) => {
    const admins = await roleRepo.listPlatformAdmins();
    return c.json({ admins });
  });

  // POST /api/admin/platform-admins — add a platform admin
  routes.post("/", async (c) => {
    const body = await c.req.json<{ userId: string }>().catch(() => null);

    if (!body?.userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const currentUser = c.get("user");
    await roleRepo.setRole(body.userId, PLATFORM_TENANT, "platform_admin", currentUser.id);

    return c.json({ ok: true });
  });

  // DELETE /api/admin/platform-admins/:userId — remove a platform admin
  routes.delete("/:userId", async (c) => {
    const userId = c.req.param("userId");

    // First check if the user is actually a platform admin
    const isTargetAdmin = await roleRepo.isPlatformAdmin(userId);

    // Prevent removing the last platform admin (only if target is actually an admin)
    if (isTargetAdmin) {
      const count = await roleRepo.countPlatformAdmins();
      if (count <= 1) {
        return c.json({ error: "Cannot remove the last platform admin", isTargetAdmin, count }, 409);
      }
    }

    const removed = await roleRepo.removeRole(userId, PLATFORM_TENANT);
    if (!removed) {
      return c.json({ error: "Platform admin not found", isTargetAdmin }, 404);
    }

    return c.json({ ok: true });
  });

  return routes;
}
