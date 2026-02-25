import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt, generateInstanceKey } from "../encryption.js";
import { migratePlaintextCredentials } from "./migrate-plaintext.js";
import { auditCredentialEncryption } from "./migration-check.js";

const PROVIDER_CREDS_DDL = `CREATE TABLE provider_credentials (
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
)`;

const TENANT_KEYS_DDL = `CREATE TABLE tenant_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  encrypted_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`;

describe("auditCredentialEncryption", () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    sqlite.exec(PROVIDER_CREDS_DDL);
    db = drizzle(sqlite);
  });

  afterEach(() => sqlite.close());

  it("returns empty array when all credentials are properly encrypted", () => {
    const key = generateInstanceKey();
    const encrypted = JSON.stringify(encrypt("sk-ant-test123", key));
    sqlite.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run("cred-1", encrypted);

    const findings = auditCredentialEncryption(db);
    expect(findings).toEqual([]);
  });

  it("detects plaintext API keys", () => {
    sqlite
      .prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)")
      .run("cred-1", "sk-ant-api12345678901234567890");

    const findings = auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
    expect(findings[0].table).toBe("provider_credentials");
    expect(findings[0].rowId).toBe("cred-1");
  });

  it("detects malformed encrypted payloads (missing fields)", () => {
    sqlite.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run(
      "cred-1",
      JSON.stringify({ iv: "aa" }), // missing authTag and ciphertext
    );

    const findings = auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
  });

  it("returns empty array when table has no rows", () => {
    const findings = auditCredentialEncryption(db);
    expect(findings).toEqual([]);
  });

  it("handles missing tenant_api_keys table gracefully", () => {
    // tenant_api_keys table not created — should not throw
    const findings = auditCredentialEncryption(db);
    expect(findings).toEqual([]);
  });

  it("detects plaintext in tenant_api_keys when table exists", () => {
    sqlite.exec(TENANT_KEYS_DDL);
    db = drizzle(sqlite);
    sqlite
      .prepare("INSERT INTO tenant_api_keys (id, tenant_id, encrypted_key) VALUES (?, ?, ?)")
      .run("tk-1", "tenant-a", "sk-ant-api12345678901234567890");

    const findings = auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
    expect(findings[0].table).toBe("tenant_api_keys");
    expect(findings[0].rowId).toBe("tk-1");
  });
});

describe("migratePlaintextCredentials", () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof drizzle>;
  let vaultKey: Buffer;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    vaultKey = generateInstanceKey();
    sqlite.exec(PROVIDER_CREDS_DDL);
    db = drizzle(sqlite);
  });

  afterEach(() => sqlite.close());

  it("skips already-encrypted rows", () => {
    const encrypted = JSON.stringify(encrypt("sk-ant-test", vaultKey));
    sqlite.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run("cred-1", encrypted);

    const results = migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].migratedCount).toBe(0);
    expect(results[0].errors).toHaveLength(0);
  });

  it("encrypts plaintext rows", () => {
    sqlite
      .prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)")
      .run("cred-1", "sk-ant-plaintext-key-1234567890");

    const results = migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].migratedCount).toBe(1);

    // Verify the value is now encrypted JSON
    const row = sqlite.prepare("SELECT encrypted_value FROM provider_credentials WHERE id = ?").get("cred-1") as {
      encrypted_value: string;
    };
    const parsed = JSON.parse(row.encrypted_value);
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("authTag");
    expect(parsed).toHaveProperty("ciphertext");
  });

  it("handles missing tenant_api_keys table gracefully", () => {
    // Should not throw when table doesn't exist
    const results = migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].table).toBe("provider_credentials");
  });

  it("migrates tenant_api_keys when table exists", () => {
    sqlite.exec(TENANT_KEYS_DDL);
    db = drizzle(sqlite);
    sqlite
      .prepare("INSERT INTO tenant_api_keys (id, tenant_id, encrypted_key) VALUES (?, ?, ?)")
      .run("tk-1", "tenant-a", "sk-ant-plaintext-key-1234567890");

    const results = migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(tenantResult).toBeDefined();
    expect(tenantResult?.migratedCount).toBe(1);
  });

  it("returns table name in results", () => {
    const results = migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].table).toBe("provider_credentials");
  });
});
