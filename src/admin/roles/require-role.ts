import type { Context, Next } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import type { RoleStore } from "./role-store.js";

/**
 * Create middleware that requires the authenticated user to be a platform admin.
 *
 * Checks the RoleStore for a platform_admin role entry. Must be used after
 * auth middleware that sets `c.get("user")`.
 */
export function requirePlatformAdmin(roleStore: RoleStore) {
  return async (c: Context<AuthEnv>, next: Next) => {
    let user;
    try {
      user = c.get("user");
    } catch {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!roleStore.isPlatformAdmin(user.id)) {
      return c.json({ error: "Platform admin access required" }, 403);
    }

    return next();
  };
}

/**
 * Create middleware that requires the authenticated user to be at least a
 * tenant admin for the tenant identified in the request.
 *
 * Accepts platform_admin (always) or tenant_admin for the specific tenant.
 *
 * @param roleStore - The role store instance
 * @param tenantIdKey - The route parameter name containing the tenant ID (default: "tenantId")
 */
export function requireTenantAdmin(roleStore: RoleStore, tenantIdKey = "tenantId") {
  return async (c: Context<AuthEnv>, next: Next) => {
    let user;
    try {
      user = c.get("user");
    } catch {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Platform admins can manage any tenant
    if (roleStore.isPlatformAdmin(user.id)) {
      return next();
    }

    const tenantId = c.req.param(tenantIdKey);
    if (!tenantId) {
      return c.json({ error: "Tenant ID required" }, 400);
    }

    const role = roleStore.getRole(user.id, tenantId);
    if (role !== "tenant_admin") {
      return c.json({ error: "Tenant admin access required" }, 403);
    }

    return next();
  };
}
