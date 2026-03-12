import { createAdminOnboardingRoutes as _create } from "@wopr-network/platform-core/api/routes/admin-onboarding";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";
import { getAdminAuditLog } from "../../platform-services.js";

// Re-export factory from core
export { createAdminOnboardingRoutes } from "@wopr-network/platform-core/api/routes/admin-onboarding";

export function mountAdminOnboardingRoutes(
  getRepo: () => import("@wopr-network/platform-core/onboarding/drizzle-onboarding-script-repository").IOnboardingScriptRepository,
): Hono<AuthEnv> {
  const metadataMap = buildTokenMetadataMap();
  const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");
  const wrapper = new Hono<AuthEnv>();
  wrapper.use("*", adminAuth);
  wrapper.route("/", _create(getRepo, getAdminAuditLog));
  return wrapper;
}
