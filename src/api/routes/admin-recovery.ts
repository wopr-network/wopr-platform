import type { CapacityAlertChecker } from "@wopr-network/platform-core/api/routes/admin-recovery";
import {
  createAdminNodeRoutes as _createNodes,
  createAdminRecoveryRoutes as _createRecovery,
} from "@wopr-network/platform-core/api/routes/admin-recovery";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import { checkCapacityAlerts } from "@wopr-network/platform-core/fleet/capacity-alerts";
import {
  getBotInstanceRepo,
  getCommandBus,
  getMigrationOrchestrator,
  getNodeDrainer,
  getNodeProvisioner,
  getNodeRepo,
  getRecoveryOrchestrator,
  getRecoveryRepo,
} from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";
import { getAdminAuditLog } from "../../fleet/services.js";

// Re-export factories from core
export {
  createAdminNodeRoutes,
  createAdminRecoveryRoutes,
} from "@wopr-network/platform-core/api/routes/admin-recovery";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin recovery routes with auth. */
export const adminRecoveryRoutes = new Hono<AuthEnv>();
adminRecoveryRoutes.use("*", adminAuth);
adminRecoveryRoutes.route(
  "/",
  _createRecovery({
    recoveryRepo: getRecoveryRepo,
    recoveryOrchestrator: getRecoveryOrchestrator,
    auditLogger: getAdminAuditLog,
    logger,
  }),
);

/** Pre-built admin node management routes with auth. */
export const adminNodeRoutes = new Hono<AuthEnv>();
adminNodeRoutes.use("*", adminAuth);
adminNodeRoutes.route(
  "/",
  _createNodes({
    nodeRepo: getNodeRepo,
    nodeProvisioner: getNodeProvisioner,
    nodeDrainer: getNodeDrainer,
    botInstanceRepo: getBotInstanceRepo,
    recoveryOrchestrator: getRecoveryOrchestrator,
    migrationOrchestrator: getMigrationOrchestrator,
    commandBus: getCommandBus,
    capacityAlertChecker: checkCapacityAlerts as CapacityAlertChecker,
    auditLogger: getAdminAuditLog,
    logger,
  }),
);
