import { RoleStore } from "@wopr-network/platform-core/admin";
import {
  createPlatformAdminRoutes as _createPlatformAdmin,
  createAdminRolesRoutes as _createRoles,
} from "@wopr-network/platform-core/api/routes/admin-roles";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import type { Hono } from "hono";
import { getAdminAuditLog } from "../../fleet/services.js";

// Re-export middleware from core
export { requirePlatformAdmin, requireTenantAdmin } from "@wopr-network/platform-core/api/routes/admin-roles";

export interface AdminRolesRouteDeps {
  db: DrizzleDb;
}

/**
 * Backward-compatible factory: takes a DrizzleDb and creates a RoleStore internally.
 */
export function createAdminRolesRoutes(dbOrFactory: DrizzleDb | (() => DrizzleDb)): Hono<AuthEnv> {
  const resolveDb = typeof dbOrFactory === "function" ? dbOrFactory : () => dbOrFactory;
  let roleStore: RoleStore | undefined;
  function getRoleStore(): RoleStore {
    if (!roleStore) roleStore = new RoleStore(resolveDb());
    return roleStore;
  }
  return _createRoles(getRoleStore, getAdminAuditLog);
}

/**
 * Backward-compatible factory: takes a DrizzleDb and creates a RoleStore internally.
 */
export function createPlatformAdminRoutes(dbOrFactory: DrizzleDb | (() => DrizzleDb)): Hono<AuthEnv> {
  const resolveDb = typeof dbOrFactory === "function" ? dbOrFactory : () => dbOrFactory;
  let roleStore: RoleStore | undefined;
  function getRoleStore(): RoleStore {
    if (!roleStore) roleStore = new RoleStore(resolveDb());
    return roleStore;
  }
  return _createPlatformAdmin(getRoleStore, getAdminAuditLog);
}
