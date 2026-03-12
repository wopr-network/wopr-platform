import { createAdminGpuRoutes as _create } from "@wopr-network/platform-core/api/routes/admin-gpu";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import { getDOClient, getGpuNodeProvisioner, getGpuNodeRepository } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";
import { getAdminAuditLog } from "../../platform-services.js";

// Re-export factory from core
export { createAdminGpuRoutes } from "@wopr-network/platform-core/api/routes/admin-gpu";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin GPU routes with auth and lazy initialization. */
export const adminGpuRoutes = new Hono<AuthEnv>();
adminGpuRoutes.use("*", adminAuth);
adminGpuRoutes.route(
  "/",
  _create({
    gpuNodeRepo: getGpuNodeRepository,
    gpuNodeProvisioner: getGpuNodeProvisioner,
    doClient: getDOClient,
    auditLogger: getAdminAuditLog,
    logger,
  }),
);
