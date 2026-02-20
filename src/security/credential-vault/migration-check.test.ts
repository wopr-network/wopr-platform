import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt, generateInstanceKey } from "../encryption.js";
import { migratePlaintextCredentials } from "./migrate-plaintext.js";
import { auditCredentialEncryption } from "./migration-check.js";

describe("auditCredentialEncryption", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    db.exec(`CREATE TABLE provider_credentials (
      id TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL
    )`);
  });

  afterEach(() => db.close());

  it("returns empty array when all credentials are properly encrypted", () => {
    const key = generateInstanceKey();
    const encrypted = JSON.stringify(encrypt("sk-ant-test123", key));
    db.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run("cred-1", encrypted);

    const findings = auditCredentialEncryption(db);
    expect(findings).toEqual([]);
  });

  it("detects plaintext API keys", () => {
    db.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run(
      "cred-1",
      "sk-ant-api12345678901234567890",
    );

    const findings = auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
    expect(findings[0].table).toBe("provider_credentials");
    expect(findings[0].rowId).toBe("cred-1");
  });

  it("detects malformed encrypted payloads (missing fields)", () => {
    db.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run(
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
    db.exec(`CREATE TABLE tenant_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      encrypted_key TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO tenant_api_keys (id, tenant_id, encrypted_key) VALUES (?, ?, ?)").run(
      "tk-1",
      "tenant-a",
      "sk-ant-api12345678901234567890",
    );

    const findings = auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
    expect(findings[0].table).toBe("tenant_api_keys");
    expect(findings[0].rowId).toBe("tk-1");
  });
});

describe("migratePlaintextCredentials", () => {
  let db: BetterSqlite3.Database;
  let vaultKey: Buffer;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    vaultKey = generateInstanceKey();
    db.exec(`CREATE TABLE provider_credentials (
      id TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL
    )`);
  });

  afterEach(() => db.close());

  it("skips already-encrypted rows", () => {
    const encrypted = JSON.stringify(encrypt("sk-ant-test", vaultKey));
    db.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run("cred-1", encrypted);

    const results = migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].migratedCount).toBe(0);
    expect(results[0].errors).toHaveLength(0);
  });

  it("encrypts plaintext rows", () => {
    db.prepare("INSERT INTO provider_credentials (id, encrypted_value) VALUES (?, ?)").run(
      "cred-1",
      "sk-ant-plaintext-key-1234567890",
    );

    const results = migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].migratedCount).toBe(1);

    // Verify the value is now encrypted JSON
    const row = db.prepare("SELECT encrypted_value FROM provider_credentials WHERE id = ?").get("cred-1") as {
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
    db.exec(`CREATE TABLE tenant_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      encrypted_key TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO tenant_api_keys (id, tenant_id, encrypted_key) VALUES (?, ?, ?)").run(
      "tk-1",
      "tenant-a",
      "sk-ant-plaintext-key-1234567890",
    );

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
