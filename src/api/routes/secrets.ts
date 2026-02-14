import { Hono } from "hono";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant, validateTenantOwnership } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { decrypt, deriveInstanceKey } from "../../security/encryption.js";
import { forwardSecretsToInstance, writeEncryptedSeed } from "../../security/key-injection.js";
import { validateProviderKey } from "../../security/key-validation.js";
import { validateKeyRequestSchema, writeSecretsRequestSchema } from "../../security/types.js";

const PLATFORM_SECRET = process.env.PLATFORM_SECRET;
const INSTANCE_DATA_DIR = process.env.INSTANCE_DATA_DIR || "/data/instances";
const FLEET_DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";

/** Allowlist: only alphanumeric, hyphens, and underscores. */
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id);
}

/** Helper to get instance tenantId from bot profile */
async function getInstanceTenantId(instanceId: string): Promise<string | undefined> {
  try {
    const { ProfileStore } = await import("../../fleet/profile-store.js");
    const store = new ProfileStore(FLEET_DATA_DIR);
    const profile = await store.get(instanceId);
    return profile?.tenantId;
  } catch {
    return undefined;
  }
}

export const secretsRoutes = new Hono();

// Secrets management requires write scope
const tokenMetadataMap = buildTokenMetadataMap();
if (tokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured — secrets routes will reject all requests");
}
secretsRoutes.use("/*", scopedBearerAuthWithTenant(tokenMetadataMap, "write"));

/**
 * PUT /instances/:id/config/secrets
 *
 * Writes secrets to a running instance by forwarding the body opaquely,
 * or writes an encrypted seed file if the instance is not running.
 *
 * The platform NEVER parses, logs, or persists the plaintext secret values.
 * For running instances: opaque pass-through to the container.
 * For pre-boot: encrypts with instance-derived key, writes to volume.
 */
secretsRoutes.put("/instances/:id/config/secrets", async (c) => {
  const instanceId = c.req.param("id");
  if (!isValidInstanceId(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  // Validate tenant ownership of the instance
  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const mode = c.req.query("mode") || "proxy";

  if (mode === "seed") {
    // Pre-boot: parse body to encrypt, then discard plaintext
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = writeSecretsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    if (!PLATFORM_SECRET) {
      return c.json({ error: "Platform secret not configured" }, 500);
    }

    try {
      const instanceKey = deriveInstanceKey(instanceId, PLATFORM_SECRET);
      const woprHome = `${INSTANCE_DATA_DIR}/${instanceId}`;
      await writeEncryptedSeed(woprHome, parsed.data, instanceKey);
      return c.json({ ok: true, mode: "seed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to write seed";
      logger.error("Failed to write encrypted seed", { instanceId, error: message });
      return c.json({ error: "Failed to write encrypted seed" }, 500);
    }
  }

  // Default: proxy mode — forward body opaquely to the instance container
  const rawBody = await c.req.text();
  const instanceUrl = `http://wopr-${instanceId}:3000`;
  const authHeader = c.req.header("Authorization") || "";
  const sessionToken = authHeader.replace(/^Bearer\s+/i, "");

  const result = await forwardSecretsToInstance(instanceUrl, sessionToken, rawBody);
  if (result.ok) {
    return c.json({ ok: true, mode: "proxy" });
  }
  const status = result.status === 502 ? 502 : result.status === 503 ? 503 : result.status === 404 ? 404 : 500;
  return c.json({ error: result.error || "Proxy failed" }, status);
});

/**
 * POST /validate-key
 *
 * Validates a provider API key without logging or persisting it.
 * Accepts an encrypted key payload, decrypts in memory, validates, and discards.
 *
 * SECURITY: The plaintext key exists only in local variables during validation.
 * It is NEVER logged, NEVER written to disk, NEVER returned in the response.
 */
secretsRoutes.post("/validate-key", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = validateKeyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const { provider, encryptedKey } = parsed.data;

  // Decrypt the key in memory
  let plaintextKey: string;
  try {
    const encryptedPayload = JSON.parse(encryptedKey);
    const instanceId = c.req.query("instanceId");
    if (!instanceId) {
      return c.json({ error: "instanceId query parameter required" }, 400);
    }
    if (!isValidInstanceId(instanceId)) {
      return c.json({ error: "Invalid instance ID" }, 400);
    }

    // Validate tenant ownership of the instance
    const tenantId = await getInstanceTenantId(instanceId);
    const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
    if (ownershipError) {
      return ownershipError;
    }
    if (!PLATFORM_SECRET) {
      return c.json({ error: "Platform secret not configured" }, 500);
    }
    const instanceKey = deriveInstanceKey(instanceId, PLATFORM_SECRET);
    plaintextKey = decrypt(encryptedPayload, instanceKey);
  } catch {
    return c.json({ error: "Failed to decrypt key payload" }, 400);
  }

  // Validate against the provider API
  const result = await validateProviderKey(provider, plaintextKey);

  // Explicitly discard the key reference
  plaintextKey = "";

  return c.json({ valid: result.valid, error: result.error });
});
