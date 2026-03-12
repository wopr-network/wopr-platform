import { createTenantKeyRoutes } from "@wopr-network/platform-core/api/routes/tenant-keys";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { ITenantKeyRepository } from "@wopr-network/platform-core/security";
import { Hono } from "hono";

export type { TenantKeyDeps } from "@wopr-network/platform-core/api/routes/tenant-keys";
// Re-export factory from core
export { createTenantKeyRoutes } from "@wopr-network/platform-core/api/routes/tenant-keys";

const PLATFORM_SECRET = process.env.PLATFORM_SECRET;

let repo: ITenantKeyRepository | null = null;

function getRepo(): ITenantKeyRepository {
  if (!repo) throw new Error("TenantKeyRepository not initialized — call setRepo() first");
  return repo;
}

/** Inject a TenantKeyRepository for testing or production wiring. */
export function setRepo(s: ITenantKeyRepository): void {
  repo = s;
}

/** Pre-built tenant key routes with auth and platform secret. */
export const tenantKeyRoutes = new Hono();

const tokenMetadataMap = buildTokenMetadataMap();
if (tokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured — tenant key routes will reject all requests");
}
tenantKeyRoutes.use("/*", scopedBearerAuthWithTenant(tokenMetadataMap, "write"));
tenantKeyRoutes.route("/", createTenantKeyRoutes({ repo: getRepo, platformSecret: PLATFORM_SECRET }));
