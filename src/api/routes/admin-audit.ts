import { AdminAuditLog, DrizzleAdminAuditLogRepository } from "@wopr-network/platform-core/admin";
import { createAdminAuditApiRoutes as _createAdminAuditApiRoutes } from "@wopr-network/platform-core/api/routes/admin-audit";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { getDb } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";

// Re-export factory from core — other brands use this directly
export { createAdminAuditApiRoutes } from "@wopr-network/platform-core/api/routes/admin-audit";

function getAuditLog(): AdminAuditLog {
  return new AdminAuditLog(new DrizzleAdminAuditLogRepository(getDb()));
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin audit routes with auth and lazy DB initialization. */
export const adminAuditApiRoutes = new Hono<AuthEnv>();
adminAuditApiRoutes.use("*", adminAuth);
adminAuditApiRoutes.route("/", _createAdminAuditApiRoutes(getAuditLog));
