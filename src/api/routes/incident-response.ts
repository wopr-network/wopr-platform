import { createIncidentResponseRoutes } from "@wopr-network/platform-core/api/routes/incident-response";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";

// Re-export factory from core
export { createIncidentResponseRoutes } from "@wopr-network/platform-core/api/routes/incident-response";

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built incident response routes with admin auth. */
export const incidentResponseRoutes = new Hono<AuthEnv>();
incidentResponseRoutes.use("*", adminAuth);
incidentResponseRoutes.route("/", createIncidentResponseRoutes());
