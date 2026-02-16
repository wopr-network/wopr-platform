import type { Context, Next } from "hono";
import type { AuthEnv, AuthUser } from "../../auth/index.js";
import type { RoleRepository } from "../../domain/repositories/role-repository.js";

/**
 * Create middleware that requires the authenticated user to be a platform admin.
 *
 * Checks the RoleRepository for a platform_admin role entry. Must be used after
 * auth middleware that sets `c.get("user")`.
 */
export function requirePlatformAdmin(roleRepo: RoleRepository) {
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

    if (!(await roleRepo.isPlatformAdmin(user.id))) {
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
 * @param roleRepo - The role repository instance
 * @param tenantIdKey - The route parameter name containing the tenant ID (default: "tenantId")
 */
export function requireTenantAdmin(roleRepo: RoleRepository, tenantIdKey = "tenantId") {
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

    // Platform admins can manage any tenant
    if (await roleRepo.isPlatformAdmin(user.id)) {
      return next();
    }

    const tenantId = c.req.param(tenantIdKey);
    if (!tenantId) {
      return c.json({ error: "Tenant ID required" }, 400);
    }

    const role = await roleRepo.getRole(user.id, tenantId);
    if (role !== "tenant_admin") {
      return c.json({ error: "Tenant admin access required" }, 403);
    }

    return next();
  };
}
