import { createSecretsRoutes } from "@wopr-network/platform-core/api/routes/secrets";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import {
  decrypt,
  deriveInstanceKey,
  forwardSecretsToInstance,
  validateProviderKey,
  writeEncryptedSeed,
} from "@wopr-network/platform-core/security";
import { Hono } from "hono";

export type { IProfileLookup, SecretsDeps } from "@wopr-network/platform-core/api/routes/secrets";
// Re-export factory and types from core
export { createSecretsRoutes } from "@wopr-network/platform-core/api/routes/secrets";

const PLATFORM_SECRET = process.env.PLATFORM_SECRET;
const INSTANCE_DATA_DIR = process.env.INSTANCE_DATA_DIR || "/data/instances";
const FLEET_DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";

/** Helper to get instance tenantId from bot profile */
async function getInstanceTenantId(instanceId: string): Promise<string | undefined> {
  try {
    const { ProfileStore } = await import("@wopr-network/platform-core/fleet/profile-store");
    const store = new ProfileStore(FLEET_DATA_DIR);
    const profile = await store.get(instanceId);
    return profile?.tenantId;
  } catch {
    return undefined;
  }
}

/** Pre-built secrets routes with auth and platform services. */
export const secretsRoutes = new Hono();

const tokenMetadataMap = buildTokenMetadataMap();
if (tokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured — secrets routes will reject all requests");
}
secretsRoutes.use("/*", scopedBearerAuthWithTenant(tokenMetadataMap, "write"));
secretsRoutes.route(
  "/",
  createSecretsRoutes({
    profileLookup: { getInstanceTenantId },
    platformSecret: PLATFORM_SECRET,
    instanceDataDir: INSTANCE_DATA_DIR,
    logger,
    // Pass security functions through so tests can mock @wopr-network/platform-core/security
    security: {
      decrypt,
      deriveInstanceKey,
      writeEncryptedSeed,
      forwardSecretsToInstance,
      validateProviderKey,
    },
  }),
);
