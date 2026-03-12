import { AdminAuditLog, DrizzleAdminAuditLogRepository } from "@wopr-network/platform-core/admin";
import { createAdminAuditApiRoutes as _createAdminAuditApiRoutes } from "@wopr-network/platform-core/api/routes/admin-audit";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { Hono } from "hono";

// Re-export factory from core — other brands use this directly
export { createAdminAuditApiRoutes } from "@wopr-network/platform-core/api/routes/admin-audit";

export interface AdminAuditRouteDeps {
  db: DrizzleDb;
}

let _db: DrizzleDb | null = null;

/** Set dependencies for admin audit routes. */
export function setAdminAuditDeps(deps: AdminAuditRouteDeps): void {
  _db = deps.db;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin audit routes with auth and lazy initialization. */
export const adminAuditApiRoutes = new Hono<AuthEnv>();
adminAuditApiRoutes.use("*", adminAuth);
adminAuditApiRoutes.all("/*", (c) => {
  if (!_db) throw new Error("Admin audit routes not initialized -- call setAdminAuditDeps() first");
  const db = _db;
  const inner = _createAdminAuditApiRoutes(() => new AdminAuditLog(new DrizzleAdminAuditLogRepository(db)));
  return inner.fetch(c.req.raw);
});
