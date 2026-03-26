import { createAdminMigrationRoutes } from "@wopr-network/platform-core/api/routes/admin-migration";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { getMigrationOrchestrator } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";
import { getAdminAuditLog } from "../../fleet/services.js";

// Re-export factory from core
export { createAdminMigrationRoutes } from "@wopr-network/platform-core/api/routes/admin-migration";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

export const adminMigrationRoutes = new Hono<AuthEnv>();
adminMigrationRoutes.use("*", adminAuth);
adminMigrationRoutes.route("/", createAdminMigrationRoutes(getMigrationOrchestrator, getAdminAuditLog));
