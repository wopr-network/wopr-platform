import { createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { decrypt, encrypt } from "../encryption.js";
import type { EncryptedPayload } from "../types.js";
import { reEncryptAllCredentials } from "./key-rotation.js";
import { getVaultEncryptionKey } from "./store.js";

const OLD_SECRET = "old-platform-secret-for-test";
const NEW_SECRET = "new-platform-secret-for-test";

const NOW_EPOCH = Math.floor(Date.now() / 1000);

function deriveTenantKey(tenantId: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`tenant:${tenantId}`).digest();
}

describe("reEncryptAllCredentials", () => {
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("re-encrypts provider credentials from old to new secret", async () => {
    const oldKey = getVaultEncryptionKey(OLD_SECRET);
    const encrypted = encrypt("sk-ant-real-key-12345", oldKey);
    await pool.query(
      "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      ["cred-1", "openrouter", "default", JSON.stringify(encrypted), "bearer", "test"],
    );

    const result = await reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(1);
    expect(result.providerCredentials.errors).toHaveLength(0);

    const row = await pool.query<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM provider_credentials WHERE id = $1",
      ["cred-1"],
    );
    const newKey = getVaultEncryptionKey(NEW_SECRET);
    const payload: EncryptedPayload = JSON.parse(row.rows[0].encrypted_value);
    const decrypted = decrypt(payload, newKey);
    expect(decrypted).toBe("sk-ant-real-key-12345");

    const oldKey2 = getVaultEncryptionKey(OLD_SECRET);
    expect(() => decrypt(payload, oldKey2)).toThrow();
  });

  it("re-encrypts tenant BYOK keys from old to new secret", async () => {
    const oldTenantKey = deriveTenantKey("t1", OLD_SECRET);
    const encrypted = encrypt("sk-openai-tenant-key", oldTenantKey);
    await pool.query(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, encrypted_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
      ["tk-1", "t1", "openai", JSON.stringify(encrypted), NOW_EPOCH, NOW_EPOCH],
    );

    const result = await reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.tenantKeys.migrated).toBe(1);
    expect(result.tenantKeys.errors).toHaveLength(0);

    const row = await pool.query<{ encrypted_key: string }>("SELECT encrypted_key FROM tenant_api_keys WHERE id = $1", [
      "tk-1",
    ]);
    const newTenantKey = deriveTenantKey("t1", NEW_SECRET);
    const payload: EncryptedPayload = JSON.parse(row.rows[0].encrypted_key);
    expect(decrypt(payload, newTenantKey)).toBe("sk-openai-tenant-key");
  });

  it("handles mixed valid and invalid rows gracefully", async () => {
    const oldKey = getVaultEncryptionKey(OLD_SECRET);
    const encrypted = encrypt("valid-key", oldKey);
    await pool.query(
      "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      ["cred-1", "openrouter", "default", JSON.stringify(encrypted), "bearer", "test"],
    );
    await pool.query(
      "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      ["cred-2", "openrouter", "default", "not-valid-json", "bearer", "test"],
    );

    const result = await reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(1);
    expect(result.providerCredentials.errors).toHaveLength(1);
    expect(result.providerCredentials.errors[0]).toContain("cred-2");
  });

  it("returns zero counts when tables are empty", async () => {
    const result = await reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(0);
    expect(result.tenantKeys.migrated).toBe(0);
  });

  it("re-encrypts multiple provider credentials", async () => {
    const oldKey = getVaultEncryptionKey(OLD_SECRET);
    for (let i = 1; i <= 3; i++) {
      const encrypted = encrypt(`sk-key-${i}`, oldKey);
      await pool.query(
        "INSERT INTO provider_credentials (id, provider, key_name, encrypted_value, auth_type, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [`cred-${i}`, "openrouter", "default", JSON.stringify(encrypted), "bearer", "test"],
      );
    }

    const result = await reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(3);

    const newKey = getVaultEncryptionKey(NEW_SECRET);
    for (let i = 1; i <= 3; i++) {
      const row = await pool.query<{ encrypted_value: string }>(
        "SELECT encrypted_value FROM provider_credentials WHERE id = $1",
        [`cred-${i}`],
      );
      const payload: EncryptedPayload = JSON.parse(row.rows[0].encrypted_value);
      expect(decrypt(payload, newKey)).toBe(`sk-key-${i}`);
    }
  });
});
