import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { z } from "zod";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import * as dbSchema from "../../db/schema/index.js";
import type { TenantKeyRepository } from "../../domain/repositories/tenant-key-repository.js";
import { DrizzleTenantKeyRepository } from "../../infrastructure/persistence/drizzle-tenant-key-repository.js";
import { encrypt } from "../../security/encryption.js";
import { providerSchema } from "../../security/types.js";

const DB_PATH = process.env.TENANT_KEYS_DB_PATH || "/data/platform/tenant-keys.db";
const PLATFORM_SECRET = process.env.PLATFORM_SECRET;

/** Derive a per-tenant encryption key from tenant ID and platform secret. */
function deriveTenantKey(tenantId: string, platformSecret: string): Buffer {
  return createHmac("sha256", platformSecret).update(`tenant:${tenantId}`).digest();
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const storeKeySchema = z.object({
  provider: providerSchema,
  apiKey: z.string().min(1, "API key is required"),
  label: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

export const tenantKeyRoutes = new Hono();

const tokenMetadataMap = buildTokenMetadataMap();
if (tokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured — tenant key routes will reject all requests");
}
tenantKeyRoutes.use("/*", scopedBearerAuthWithTenant(tokenMetadataMap, "write"));

let repo: TenantKeyRepository | null = null;

function getRepo(): TenantKeyRepository {
  if (!repo) {
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    repo = new DrizzleTenantKeyRepository(drizzleDb);
  }
  return repo;
}

/** Inject a TenantKeyRepository for testing. */
export function setRepo(r: TenantKeyRepository): void {
  repo = r;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /tenant-keys
 *
 * List all API keys for the authenticated tenant.
 * Returns metadata only (never the encrypted key material).
 */
tenantKeyRoutes.get("/", async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) {
    return c.json({ error: "Tenant context required" }, 400);
  }

  const keys = await getRepo().listForTenant(tenantId);
  return c.json({ keys });
});

/**
 * GET /tenant-keys/:provider
 *
 * Check whether the tenant has a stored key for a specific provider.
 * Returns metadata only.
 */
tenantKeyRoutes.get("/:provider", async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) {
    return c.json({ error: "Tenant context required" }, 400);
  }

  const provider = c.req.param("provider");
  const parsed = providerSchema.safeParse(provider);
  if (!parsed.success) {
    return c.json({ error: "Invalid provider", validProviders: providerSchema.options }, 400);
  }

  const record = await getRepo().get(tenantId, parsed.data);
  if (!record) {
    return c.json({ error: "No key stored for this provider" }, 404);
  }

  // Return metadata only, never the encrypted key
  return c.json({
    id: record.id,
    tenant_id: record.tenantId,
    provider: record.provider,
    label: record.label,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  });
});

/**
 * PUT /tenant-keys/:provider
 *
 * Store or replace a tenant's API key for a provider.
 * The key is encrypted at rest using AES-256-GCM with a tenant-derived key.
 *
 * SECURITY: The plaintext key exists only in memory during encryption.
 * It is NEVER logged, persisted in plaintext, or returned in the response.
 */
tenantKeyRoutes.put("/:provider", async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) {
    return c.json({ error: "Tenant context required" }, 400);
  }

  const provider = c.req.param("provider");
  const providerParsed = providerSchema.safeParse(provider);
  if (!providerParsed.success) {
    return c.json({ error: "Invalid provider", validProviders: providerSchema.options }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = storeKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  if (parsed.data.provider !== providerParsed.data) {
    return c.json({ error: "Provider in body must match URL parameter" }, 400);
  }

  if (!PLATFORM_SECRET) {
    return c.json({ error: "Platform secret not configured" }, 500);
  }

  // Encrypt the key in memory, then discard the plaintext
  const tenantKey = deriveTenantKey(tenantId, PLATFORM_SECRET);
  const encryptedPayload = encrypt(parsed.data.apiKey, tenantKey);

  const id = await getRepo().upsert(tenantId, providerParsed.data, encryptedPayload, parsed.data.label ?? "");

  return c.json({ ok: true, id, provider: providerParsed.data });
});

/**
 * DELETE /tenant-keys/:provider
 *
 * Delete a tenant's stored API key for a provider.
 */
tenantKeyRoutes.delete("/:provider", async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) {
    return c.json({ error: "Tenant context required" }, 400);
  }

  const provider = c.req.param("provider");
  const parsed = providerSchema.safeParse(provider);
  if (!parsed.success) {
    return c.json({ error: "Invalid provider", validProviders: providerSchema.options }, 400);
  }

  const deleted = await getRepo().delete(tenantId, parsed.data);
  if (!deleted) {
    return c.json({ error: "No key stored for this provider" }, 404);
  }

  return c.json({ ok: true, provider: parsed.data });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the tenant ID from the auth context. */
function getTenantId(c: { get: (key: string) => unknown }): string | undefined {
  try {
    return c.get("tokenTenantId") as string | undefined;
  } catch {
    return undefined;
  }
}
