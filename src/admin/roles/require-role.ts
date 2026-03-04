import type { Context, Next } from "hono";
import type { AuthEnv, AuthUser } from "../../auth/index.js";
import type { RoleStore } from "./role-store.js";

function resolveRoleStore(storeOrFactory: RoleStore | (() => RoleStore)): RoleStore {
  return typeof storeOrFactory === "function" ? storeOrFactory() : storeOrFactory;
}

/**
 * Create middleware that requires the authenticated user to be a platform admin.
 *
 * Checks the RoleStore for a platform_admin role entry. Must be used after
 * auth middleware that sets `c.get("user")`.
 *
 * Bearer tokens with "admin" scope are implicitly treated as platform admins
 * without a DB lookup — they already passed scopedBearerAuthWithTenant.
 */
export function requirePlatformAdmin(storeOrFactory: RoleStore | (() => RoleStore)) {
  return async (c: Context<AuthEnv>, next: Next) => {
    let user: AuthUser | undefined;
    try {
      user = c.get("user");
    } catch {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Bearer tokens with "admin" scope are operator-level and implicitly have
    // platform admin access without requiring a DB role entry.
    if (!user.roles.includes("admin") && !(await resolveRoleStore(storeOrFactory).isPlatformAdmin(user.id))) {
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
 * Bearer tokens with "admin" scope are implicitly treated as platform admins
 * without a DB lookup — they already passed scopedBearerAuthWithTenant.
 *
 * @param storeOrFactory - The role store instance or factory
 * @param tenantIdKey - The route parameter name containing the tenant ID (default: "tenantId")
 */
export function requireTenantAdmin(storeOrFactory: RoleStore | (() => RoleStore), tenantIdKey = "tenantId") {
  return async (c: Context<AuthEnv>, next: Next) => {
    let user: AuthUser | undefined;
    try {
      user = c.get("user");
    } catch {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Bearer tokens with "admin" scope are operator-level and implicitly have
    // platform admin access without requiring a DB role entry.
    if (user.roles.includes("admin") || (await resolveRoleStore(storeOrFactory).isPlatformAdmin(user.id))) {
      return next();
    }

    const tenantId = c.req.param(tenantIdKey);
    if (!tenantId) {
      return c.json({ error: "Tenant ID required" }, 400);
    }

    const role = await resolveRoleStore(storeOrFactory).getRole(user.id, tenantId);
    if (role !== "tenant_admin") {
      return c.json({ error: "Tenant admin access required" }, 403);
    }

    return next();
  };
}
