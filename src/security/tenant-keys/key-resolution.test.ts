import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { encrypt, generateInstanceKey } from "../encryption.js";
import type { EncryptedPayload, Provider } from "../types.js";
import { buildPooledKeysMap, resolveApiKey } from "./key-resolution.js";

async function insertTenantKey(
  pool: PGlite,
  tenantId: string,
  provider: string,
  encryptedKey: EncryptedPayload,
): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const now = Date.now();
  await pool.query(
    "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [randomUUID(), tenantId, provider, "", JSON.stringify(encryptedKey), now, now],
  );
}

describe("resolveApiKey", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let encryptionKey: Buffer;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    encryptionKey = generateInstanceKey();
  });

  it("returns tenant BYOK key when one is stored", async () => {
    const encrypted = encrypt("sk-ant-tenant-key", encryptionKey);
    await insertTenantKey(pool, "t1", "anthropic", encrypted);

    const pooled = new Map<Provider, string>([["anthropic", "sk-ant-pooled"]]);
    const result = await resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-ant-tenant-key");
    expect(result?.source).toBe("tenant");
    expect(result?.provider).toBe("anthropic");
  });

  it("falls back to pooled key when no tenant key stored", async () => {
    const pooled = new Map<Provider, string>([["openai", "sk-pooled-openai"]]);
    const result = await resolveApiKey(db, "t1", "openai", encryptionKey, pooled);
    expect(result).not.toBeNull();
    expect(result?.key).toBe("sk-pooled-openai");
    expect(result?.source).toBe("pooled");
    expect(result?.provider).toBe("openai");
  });

  it("returns null when neither tenant nor pooled key exists", async () => {
    const pooled = new Map<Provider, string>();
    const result = await resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(result).toBeNull();
  });

  it("resolves different providers independently", async () => {
    const encrypted = encrypt("my-google-key", encryptionKey);
    await insertTenantKey(pool, "t1", "google", encrypted);

    const pooled = new Map<Provider, string>([["anthropic", "sk-ant-pooled"]]);

    const googleResult = await resolveApiKey(db, "t1", "google", encryptionKey, pooled);
    expect(googleResult?.source).toBe("tenant");
    expect(googleResult?.key).toBe("my-google-key");

    const anthropicResult = await resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(anthropicResult?.source).toBe("pooled");
    expect(anthropicResult?.key).toBe("sk-ant-pooled");

    const discordResult = await resolveApiKey(db, "t1", "discord", encryptionKey, pooled);
    expect(discordResult).toBeNull();
  });

  it("isolates keys between tenants", async () => {
    const encrypted = encrypt("t1-anthropic-key", encryptionKey);
    await insertTenantKey(pool, "t1", "anthropic", encrypted);

    const pooled = new Map<Provider, string>([["anthropic", "sk-ant-pooled"]]);

    const t1Result = await resolveApiKey(db, "t1", "anthropic", encryptionKey, pooled);
    expect(t1Result?.source).toBe("tenant");

    const t2Result = await resolveApiKey(db, "t2", "anthropic", encryptionKey, pooled);
    expect(t2Result?.source).toBe("pooled");
  });
});

describe("buildPooledKeysMap", () => {
  it("reads keys from environment variables", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-openai-test",
      GOOGLE_API_KEY: "google-test",
      DISCORD_BOT_TOKEN: "discord-test",
    };
    const keys = buildPooledKeysMap(env);
    expect(keys.get("anthropic")).toBe("sk-ant-test");
    expect(keys.get("openai")).toBe("sk-openai-test");
    expect(keys.get("google")).toBe("google-test");
    expect(keys.get("discord")).toBe("discord-test");
  });

  it("ignores missing env vars", () => {
    const keys = buildPooledKeysMap({});
    expect(keys.size).toBe(0);
  });

  it("trims whitespace from values", () => {
    const keys = buildPooledKeysMap({ ANTHROPIC_API_KEY: "  sk-ant-test  " });
    expect(keys.get("anthropic")).toBe("sk-ant-test");
  });

  it("ignores empty values", () => {
    const keys = buildPooledKeysMap({ ANTHROPIC_API_KEY: "  " });
    expect(keys.size).toBe(0);
  });
});
