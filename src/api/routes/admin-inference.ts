import { createAdminInferenceRoutes } from "@wopr-network/platform-core/api/routes/admin-inference";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { getSessionUsageRepo } from "@wopr-network/platform-core/fleet/services";
import type { ISessionUsageRepository } from "@wopr-network/platform-core/inference/session-usage-repository";
import { Hono } from "hono";

// Re-export factory from core — other brands use this directly
export { createAdminInferenceRoutes } from "@wopr-network/platform-core/api/routes/admin-inference";

let _repo: ISessionUsageRepository | null = null;

function getRepo(): ISessionUsageRepository {
  if (!_repo) {
    _repo = getSessionUsageRepo();
  }
  return _repo;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

export const adminInferenceRoutes = new Hono<AuthEnv>();
adminInferenceRoutes.use("*", adminAuth);
adminInferenceRoutes.route("/", createAdminInferenceRoutes(getRepo));
