import { createAdminCreditApiRoutes as _create } from "@wopr-network/platform-core/api/routes/admin-credits";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";
import { getAdminAuditLog, getCreditLedger } from "../../fleet/services.js";

// Re-export factory from core
export { createAdminCreditApiRoutes } from "@wopr-network/platform-core/api/routes/admin-credits";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin credit routes with auth and lazy ledger initialization. */
export const adminCreditRoutes = new Hono<AuthEnv>();
adminCreditRoutes.use("*", adminAuth);
adminCreditRoutes.route("/", _create(getCreditLedger, getAdminAuditLog));
