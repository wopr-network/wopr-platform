import { createHmac } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../encryption.js";
import type { EncryptedPayload } from "../types.js";
import { reEncryptAllCredentials } from "./key-rotation.js";
import { getVaultEncryptionKey } from "./store.js";

const OLD_SECRET = "old-platform-secret-for-test";
const NEW_SECRET = "new-platform-secret-for-test";

function deriveTenantKey(tenantId: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`tenant:${tenantId}`).digest();
}

describe("reEncryptAllCredentials", () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    sqlite.exec(`CREATE TABLE provider_credentials (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT '',
      key_name TEXT NOT NULL DEFAULT '',
      encrypted_value TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT '',
      auth_header TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_validated TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      rotated_at TEXT,
      created_by TEXT NOT NULL DEFAULT ''
    )`);
    sqlite.exec(`CREATE TABLE tenant_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`);
    db = drizzle(sqlite);
  });

  afterEach(() => sqlite.close());

  it("re-encrypts provider credentials from old to new secret", () => {
    const oldKey = getVaultEncryptionKey(OLD_SECRET);
    const encrypted = encrypt("sk-ant-real-key-12345", oldKey);
    sqlite
      .prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)")
      .run("cred-1", JSON.stringify(encrypted));

    const result = reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(1);
    expect(result.providerCredentials.errors).toHaveLength(0);

    // Verify: decryptable with new key, not old
    const row = sqlite.prepare("SELECT encrypted_value FROM provider_credentials WHERE id = ?").get("cred-1") as {
      encrypted_value: string;
    };
    const newKey = getVaultEncryptionKey(NEW_SECRET);
    const payload: EncryptedPayload = JSON.parse(row.encrypted_value);
    const decrypted = decrypt(payload, newKey);
    expect(decrypted).toBe("sk-ant-real-key-12345");

    // Old key should fail
    const oldKey2 = getVaultEncryptionKey(OLD_SECRET);
    expect(() => decrypt(payload, oldKey2)).toThrow();
  });

  it("re-encrypts tenant BYOK keys from old to new secret", () => {
    const oldTenantKey = deriveTenantKey("t1", OLD_SECRET);
    const encrypted = encrypt("sk-openai-tenant-key", oldTenantKey);
    sqlite
      .prepare("INSERT INTO tenant_api_keys (id, tenant_id, encrypted_key) VALUES (?, ?, ?)")
      .run("tk-1", "t1", JSON.stringify(encrypted));

    const result = reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.tenantKeys.migrated).toBe(1);
    expect(result.tenantKeys.errors).toHaveLength(0);

    // Verify: decryptable with new tenant key
    const row = sqlite.prepare("SELECT encrypted_key FROM tenant_api_keys WHERE id = ?").get("tk-1") as {
      encrypted_key: string;
    };
    const newTenantKey = deriveTenantKey("t1", NEW_SECRET);
    const payload: EncryptedPayload = JSON.parse(row.encrypted_key);
    expect(decrypt(payload, newTenantKey)).toBe("sk-openai-tenant-key");
  });

  it("handles mixed valid and invalid rows gracefully", () => {
    const oldKey = getVaultEncryptionKey(OLD_SECRET);
    const encrypted = encrypt("valid-key", oldKey);
    sqlite
      .prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)")
      .run("cred-1", JSON.stringify(encrypted));
    sqlite
      .prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)")
      .run("cred-2", "not-valid-json");

    const result = reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(1);
    expect(result.providerCredentials.errors).toHaveLength(1);
    expect(result.providerCredentials.errors[0]).toContain("cred-2");
  });

  it("handles missing tenant_api_keys table gracefully", () => {
    // Close and recreate DB without tenant_api_keys table
    sqlite.close();
    sqlite = new BetterSqlite3(":memory:");
    sqlite.exec(`CREATE TABLE provider_credentials (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT '',
      key_name TEXT NOT NULL DEFAULT '',
      encrypted_value TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT '',
      auth_header TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_validated TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      rotated_at TEXT,
      created_by TEXT NOT NULL DEFAULT ''
    )`);
    db = drizzle(sqlite);

    // Should not throw
    const result = reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(0);
    expect(result.tenantKeys.migrated).toBe(0);
  });

  it("re-encrypts multiple provider credentials", () => {
    const oldKey = getVaultEncryptionKey(OLD_SECRET);
    for (let i = 1; i <= 3; i++) {
      const encrypted = encrypt(`sk-key-${i}`, oldKey);
      sqlite
        .prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)")
        .run(`cred-${i}`, JSON.stringify(encrypted));
    }

    const result = reEncryptAllCredentials(db, OLD_SECRET, NEW_SECRET);
    expect(result.providerCredentials.migrated).toBe(3);

    // Verify all are re-encrypted with new key
    const newKey = getVaultEncryptionKey(NEW_SECRET);
    for (let i = 1; i <= 3; i++) {
      const row = sqlite.prepare("SELECT encrypted_value FROM provider_credentials WHERE id = ?").get(`cred-${i}`) as {
        encrypted_value: string;
      };
      const payload: EncryptedPayload = JSON.parse(row.encrypted_value);
      expect(decrypt(payload, newKey)).toBe(`sk-key-${i}`);
    }
  });
});
