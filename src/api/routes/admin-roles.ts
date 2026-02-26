import { Hono } from "hono";
import { requirePlatformAdmin, requireTenantAdmin } from "../../admin/roles/require-role.js";
import { isValidRole, RoleStore } from "../../admin/roles/role-store.js";
import type { AuthEnv } from "../../auth/index.js";
import type { DrizzleDb } from "../../db/index.js";
import { getAdminAuditLog } from "../../fleet/services.js";

export interface AdminRolesRouteDeps {
  db: DrizzleDb;
}

/**
 * Create admin role management API routes with an explicit database.
 * Used in tests to inject an in-memory database.
 */
export function createAdminRolesRoutes(db: DrizzleDb): Hono<AuthEnv> {
  const roleStore = new RoleStore(db);
  const routes = new Hono<AuthEnv>();

  // --- Tenant role routes ---

  // GET /api/admin/roles/:tenantId — list roles for a tenant
  // Platform admins can view any tenant; tenant admins can view their own
  routes.get("/:tenantId", requireTenantAdmin(roleStore), async (c) => {
    const tenantId = c.req.param("tenantId");
    const roles = await roleStore.listByTenant(tenantId);
    return c.json({ roles });
  });

  // PUT /api/admin/roles/:tenantId/:userId — set role for user in tenant
  // Platform admins can manage any tenant; tenant admins can manage their own
  routes.put("/:tenantId/:userId", requireTenantAdmin(roleStore), async (c) => {
    const tenantId = c.req.param("tenantId");
    const userId = c.req.param("userId");
    const body = await c.req.json<{ role: string }>().catch(() => null);

    if (!body?.role || !isValidRole(body.role)) {
      return c.json({ error: "Invalid role. Must be: platform_admin, tenant_admin, or user" }, 400);
    }

    const currentUser = c.get("user");

    // Only platform admins can grant platform_admin role
    if (body.role === "platform_admin" && !(await roleStore.isPlatformAdmin(currentUser.id))) {
      return c.json({ error: "Only platform admins can grant platform_admin role" }, 403);
    }

    await roleStore.setRole(userId, tenantId, body.role, currentUser.id);

    try {
      getAdminAuditLog().log({
        adminUser: currentUser.id ?? "unknown",
        action: "role.set",
        category: "roles",
        targetTenant: tenantId,
        targetUser: userId,
        details: { role: body.role },
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }

    return c.json({ ok: true });
  });

  // DELETE /api/admin/roles/:tenantId/:userId — remove role
  // Platform admins can manage any tenant; tenant admins can manage their own
  routes.delete("/:tenantId/:userId", requireTenantAdmin(roleStore), async (c) => {
    const tenantId = c.req.param("tenantId");
    const userId = c.req.param("userId");

    const removed = await roleStore.removeRole(userId, tenantId);
    if (!removed) {
      return c.json({ error: "Role not found" }, 404);
    }

    const currentUser = c.get("user");
    try {
      getAdminAuditLog().log({
        adminUser: currentUser?.id ?? "unknown",
        action: "role.remove",
        category: "roles",
        targetTenant: tenantId,
        targetUser: userId,
        details: {},
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }

    return c.json({ ok: true });
  });

  // --- Platform admin routes ---

  return routes;
}

/**
 * Create platform admin management routes with an explicit database.
 */
export function createPlatformAdminRoutes(db: DrizzleDb): Hono<AuthEnv> {
  const roleStore = new RoleStore(db);
  const routes = new Hono<AuthEnv>();

  // All platform admin routes require platform_admin role
  routes.use("*", requirePlatformAdmin(roleStore));

  // GET /api/admin/platform-admins — list all platform admins
  routes.get("/", async (c) => {
    const admins = await roleStore.listPlatformAdmins();
    return c.json({ admins });
  });

  // POST /api/admin/platform-admins — add a platform admin
  routes.post("/", async (c) => {
    const body = await c.req.json<{ userId: string }>().catch(() => null);

    if (!body?.userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const currentUser = c.get("user");
    await roleStore.setRole(body.userId, RoleStore.PLATFORM_TENANT, "platform_admin", currentUser.id);

    try {
      getAdminAuditLog().log({
        adminUser: currentUser.id ?? "unknown",
        action: "platform_admin.add",
        category: "roles",
        targetUser: body.userId,
        details: {},
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }

    return c.json({ ok: true });
  });

  // DELETE /api/admin/platform-admins/:userId — remove a platform admin
  routes.delete("/:userId", async (c) => {
    const userId = c.req.param("userId");

    // Prevent removing the last platform admin
    if ((await roleStore.countPlatformAdmins()) <= 1 && (await roleStore.isPlatformAdmin(userId))) {
      return c.json({ error: "Cannot remove the last platform admin" }, 409);
    }

    const removed = await roleStore.removeRole(userId, RoleStore.PLATFORM_TENANT);
    if (!removed) {
      return c.json({ error: "Platform admin not found" }, 404);
    }

    const currentUser = c.get("user");
    try {
      getAdminAuditLog().log({
        adminUser: currentUser?.id ?? "unknown",
        action: "platform_admin.remove",
        category: "roles",
        targetUser: userId,
        details: {},
        outcome: "success",
      });
    } catch {
      /* audit must not break request */
    }

    return c.json({ ok: true });
  });

  return routes;
}
