/**
 * E2E: Secrets management — full lifecycle (WOP-1700).
 *
 * Store → retrieve → rotate → bot resolves → delete → verify purge.
 * Uses real PGlite DB with tenant-key REST routes.
 */
import { createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { tenantApiKeys } from "../../src/db/schema/index.js";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "../../src/test/db.js";
import { TenantKeyRepository } from "@wopr-network/platform-core";
import { decrypt } from "../../src/security/encryption.js";
import type { EncryptedPayload } from "../../src/security/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-secrets-test";
const TENANT_ID_B = "tenant-secrets-other";
const TOKEN = "wopr_write_secretstoken000001";
const TOKEN_B = "wopr_write_secretstoken000002";
const PLATFORM_SECRET = "test-platform-secret-32bytes!!ok";

const authHeaders = { Authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { "Content-Type": "application/json", ...authHeaders };
const authHeadersB = { Authorization: `Bearer ${TOKEN_B}` };
const jsonHeadersB = { "Content-Type": "application/json", ...authHeadersB };

/** Derive tenant encryption key — same logic as src/api/routes/tenant-keys.ts */
function deriveTenantKey(tenantId: string, platformSecret: string): Buffer {
  return createHmac("sha256", platformSecret).update(`tenant:${tenantId}`).digest();
}

// Dynamic imports — populated in beforeAll after env stubs + resetModules
let tenantKeyRoutes: Awaited<typeof import("../../src/api/routes/tenant-keys.js")>["tenantKeyRoutes"];
let setRepo: Awaited<typeof import("../../src/api/routes/tenant-keys.js")>["setRepo"];
let resolveApiKey: Awaited<typeof import("../../src/security/tenant-keys/key-resolution.js")>["resolveApiKey"];
let DrizzleKeyResolutionRepository: Awaited<typeof import("../../src/security/tenant-keys/key-resolution-repository.js")>["DrizzleKeyResolutionRepository"];
let app: Hono;

// ---------------------------------------------------------------------------
// E2E: Secrets management lifecycle
// ---------------------------------------------------------------------------

describe("E2E: secrets management — store → retrieve → rotate → resolve → delete", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let store: TenantKeyRepository;

  beforeAll(async () => {
    // Stub env BEFORE importing route modules that read env at import time
    vi.stubEnv(`FLEET_TOKEN_${TENANT_ID}`, `write:${TOKEN}`);
    vi.stubEnv(`FLEET_TOKEN_${TENANT_ID_B}`, `write:${TOKEN_B}`);
    vi.stubEnv("PLATFORM_SECRET", PLATFORM_SECRET);

    // Reset module registry so route modules pick up fresh env values
    vi.resetModules();

    // Dynamic imports after env stubs
    const routesMod = await import("../../src/api/routes/tenant-keys.js");
    tenantKeyRoutes = routesMod.tenantKeyRoutes;
    setRepo = routesMod.setRepo;

    const keyResMod = await import("../../src/security/tenant-keys/key-resolution.js");
    resolveApiKey = keyResMod.resolveApiKey;

    const keyResRepoMod = await import("../../src/security/tenant-keys/key-resolution-repository.js");
    DrizzleKeyResolutionRepository = keyResRepoMod.DrizzleKeyResolutionRepository;

    app = new Hono();
    app.route("/api/tenant-keys", tenantKeyRoutes);

    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
    store = new TenantKeyRepository(db);
    setRepo(store);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
  });

  // -----------------------------------------------------------------------
  // 1. Store a secret
  // -----------------------------------------------------------------------

  it("stores a secret via PUT and returns ok + id", async () => {
    const res = await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        provider: "anthropic",
        apiKey: "sk-ant-test-secret-key-12345",
        label: "My Anthropic Key",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.provider).toBe("anthropic");
  });

  // -----------------------------------------------------------------------
  // 2. Retrieve the secret — verify metadata returned, key not exposed
  // -----------------------------------------------------------------------

  it("retrieves stored secret metadata via GET (no plaintext key in response)", async () => {
    // Store first
    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        provider: "anthropic",
        apiKey: "sk-ant-retrieve-test-key",
        label: "Retrieve Test",
      }),
    });

    // Retrieve
    const res = await app.request("/api/tenant-keys/anthropic", {
      headers: authHeaders,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("anthropic");
    expect(body.label).toBe("Retrieve Test");
    expect(body.tenant_id).toBe(TENANT_ID);
    // SECURITY: plaintext key must NOT appear in the response
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sk-ant-retrieve-test-key");
  });

  // -----------------------------------------------------------------------
  // 3. Encryption at rest — raw DB value is NOT plaintext
  // -----------------------------------------------------------------------

  it("stores the key encrypted at rest (raw DB value is ciphertext)", async () => {
    const plaintext = "sk-ant-encryption-at-rest-check";

    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: plaintext }),
    });

    // Read raw DB row
    const rows = await db
      .select({ encryptedKey: tenantApiKeys.encryptedKey })
      .from(tenantApiKeys)
      .where(
        and(
          eq(tenantApiKeys.tenantId, TENANT_ID),
          eq(tenantApiKeys.provider, "anthropic"),
        ),
      );

    expect(rows).toHaveLength(1);
    // Raw value must NOT contain plaintext
    expect(rows[0].encryptedKey).not.toContain(plaintext);
    // Must be valid EncryptedPayload JSON
    const parsed = JSON.parse(rows[0].encryptedKey);
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("authTag");
    expect(parsed).toHaveProperty("ciphertext");

    // Decrypt to verify round-trip
    const tenantKey = deriveTenantKey(TENANT_ID, PLATFORM_SECRET);
    const decrypted = decrypt(parsed as EncryptedPayload, tenantKey);
    expect(decrypted).toBe(plaintext);
  });

  // -----------------------------------------------------------------------
  // 4. Rotate the secret — PUT again, old value replaced
  // -----------------------------------------------------------------------

  it("rotates a secret by PUT-ing a new value (old one invalidated)", async () => {
    const oldKey = "sk-ant-old-key-to-rotate";
    const newKey = "sk-ant-new-rotated-key";

    // Store original
    const res1 = await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: oldKey }),
    });
    const { id: originalId } = await res1.json();

    // Rotate (PUT again — upsert replaces)
    const res2 = await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: newKey }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    // Same ID (upsert updates in place)
    expect(body2.id).toBe(originalId);

    // Verify old key is gone — decrypt raw DB row
    const rows = await db
      .select({ encryptedKey: tenantApiKeys.encryptedKey })
      .from(tenantApiKeys)
      .where(
        and(
          eq(tenantApiKeys.tenantId, TENANT_ID),
          eq(tenantApiKeys.provider, "anthropic"),
        ),
      );

    expect(rows).toHaveLength(1);
    const tenantKey = deriveTenantKey(TENANT_ID, PLATFORM_SECRET);
    const decrypted = decrypt(
      JSON.parse(rows[0].encryptedKey) as EncryptedPayload,
      tenantKey,
    );
    // New key is stored
    expect(decrypted).toBe(newKey);
    // Old key is NOT stored
    expect(decrypted).not.toBe(oldKey);
  });

  // -----------------------------------------------------------------------
  // 5. Bot references secret — resolveApiKey returns the tenant key
  // -----------------------------------------------------------------------

  it("bot resolves the stored secret via resolveApiKey()", async () => {
    const apiKey = "sk-ant-bot-resolution-key";

    // Store via API
    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey }),
    });

    const resolutionRepo = new DrizzleKeyResolutionRepository(db);
    const tenantKey = deriveTenantKey(TENANT_ID, PLATFORM_SECRET);
    const emptyPooledKeys = new Map();

    const resolved = await resolveApiKey(
      resolutionRepo,
      TENANT_ID,
      "anthropic",
      tenantKey,
      emptyPooledKeys,
    );

    expect(resolved).not.toBeNull();
    expect(resolved!.key).toBe(apiKey);
    expect(resolved!.source).toBe("tenant");
    expect(resolved!.provider).toBe("anthropic");
  });

  // -----------------------------------------------------------------------
  // 6. Delete secret — verify purge (hard delete, not soft)
  // -----------------------------------------------------------------------

  it("deletes a secret and it is fully purged from the DB", async () => {
    // Store
    await app.request("/api/tenant-keys/openai", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "openai", apiKey: "sk-delete-me" }),
    });

    // Confirm it exists
    const getRes = await app.request("/api/tenant-keys/openai", {
      headers: authHeaders,
    });
    expect(getRes.status).toBe(200);

    // Delete
    const delRes = await app.request("/api/tenant-keys/openai", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);

    // Verify 404 via API
    const afterRes = await app.request("/api/tenant-keys/openai", {
      headers: authHeaders,
    });
    expect(afterRes.status).toBe(404);

    // Verify purged from raw DB (no row at all, not soft-deleted)
    const rows = await db
      .select({ id: tenantApiKeys.id })
      .from(tenantApiKeys)
      .where(
        and(
          eq(tenantApiKeys.tenantId, TENANT_ID),
          eq(tenantApiKeys.provider, "openai"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 7. Retrieving deleted secret returns 404
  // -----------------------------------------------------------------------

  it("returns 404 when retrieving a deleted secret", async () => {
    // Store then delete
    await app.request("/api/tenant-keys/google", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "google", apiKey: "AIza-test-key" }),
    });
    await app.request("/api/tenant-keys/google", {
      method: "DELETE",
      headers: authHeaders,
    });

    // Retrieve — should be 404
    const res = await app.request("/api/tenant-keys/google", {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // 8. Rotation is atomic — only one row per tenant+provider
  // -----------------------------------------------------------------------

  it("rotation is atomic — exactly one row per tenant+provider after rotate", async () => {
    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-v1" }),
    });

    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-v2" }),
    });

    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-v3" }),
    });

    // Only one row should exist
    const rows = await db
      .select({ id: tenantApiKeys.id })
      .from(tenantApiKeys)
      .where(
        and(
          eq(tenantApiKeys.tenantId, TENANT_ID),
          eq(tenantApiKeys.provider, "anthropic"),
        ),
      );
    expect(rows).toHaveLength(1);

    // And it should have the latest value
    const allRows = await db
      .select({ encryptedKey: tenantApiKeys.encryptedKey })
      .from(tenantApiKeys)
      .where(
        and(
          eq(tenantApiKeys.tenantId, TENANT_ID),
          eq(tenantApiKeys.provider, "anthropic"),
        ),
      );
    const tenantKey = deriveTenantKey(TENANT_ID, PLATFORM_SECRET);
    const decrypted = decrypt(
      JSON.parse(allRows[0].encryptedKey) as EncryptedPayload,
      tenantKey,
    );
    expect(decrypted).toBe("sk-ant-v3");
  });

  // -----------------------------------------------------------------------
  // 9. List shows all providers, never shows plaintext
  // -----------------------------------------------------------------------

  it("list returns all stored keys without plaintext", async () => {
    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-list" }),
    });
    await app.request("/api/tenant-keys/openai", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "openai", apiKey: "sk-openai-list" }),
    });

    const res = await app.request("/api/tenant-keys", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(2);

    // No plaintext in response
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sk-ant-list");
    expect(raw).not.toContain("sk-openai-list");
  });

  // -----------------------------------------------------------------------
  // 10. Delete non-existent secret returns 404
  // -----------------------------------------------------------------------

  it("deleting a non-existent secret returns 404", async () => {
    const res = await app.request("/api/tenant-keys/anthropic", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // 11. Tenant isolation — secrets cannot be accessed across tenants
  // -----------------------------------------------------------------------

  it("secrets from tenant A are not accessible by tenant B", async () => {
    // Tenant A stores a secret
    await app.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-tenant-a-only" }),
    });

    // Tenant B tries to retrieve it
    const res = await app.request("/api/tenant-keys/anthropic", {
      headers: authHeadersB,
    });

    // Tenant B should get 404 (no secret for their tenant)
    expect(res.status).toBe(404);
  });
});
