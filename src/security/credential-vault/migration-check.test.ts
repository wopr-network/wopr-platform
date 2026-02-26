import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { providerCredentials, tenantApiKeys } from "../../db/schema/index.js";
import { createTestDb } from "../../test/db.js";
import { encrypt, generateInstanceKey } from "../encryption.js";
import { migratePlaintextCredentials } from "./migrate-plaintext.js";
import { auditCredentialEncryption } from "./migration-check.js";

describe("auditCredentialEncryption", () => {
  let db: DrizzleDb;
  let pool: PGlite;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    pool = testDb.pool;
  });

  afterEach(async () => {
    await pool.close();
  });

  it("returns empty array when all credentials are properly encrypted", async () => {
    const key = generateInstanceKey();
    const encrypted = JSON.stringify(encrypt("sk-ant-test123", key));
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "anthropic",
      keyName: "Test",
      encryptedValue: encrypted,
      authType: "header",
      createdBy: "admin",
    });

    const findings = await auditCredentialEncryption(db);
    expect(findings).toEqual([]);
  });

  it("detects plaintext API keys", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "anthropic",
      keyName: "Test",
      encryptedValue: "sk-ant-api12345678901234567890",
      authType: "header",
      createdBy: "admin",
    });

    const findings = await auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
    expect(findings[0].table).toBe("provider_credentials");
    expect(findings[0].rowId).toBe("cred-1");
  });

  it("detects malformed encrypted payloads (missing fields)", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "anthropic",
      keyName: "Test",
      encryptedValue: JSON.stringify({ iv: "aa" }), // missing authTag and ciphertext
      authType: "header",
      createdBy: "admin",
    });

    const findings = await auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
  });

  it("returns empty array when table has no rows", async () => {
    const findings = await auditCredentialEncryption(db);
    expect(findings).toEqual([]);
  });

  it("handles missing tenant_api_keys gracefully (no plaintext tenant keys)", async () => {
    // tenant_api_keys table exists but is empty — should not throw
    const findings = await auditCredentialEncryption(db);
    expect(findings).toEqual([]);
  });

  it("detects plaintext in tenant_api_keys when table exists", async () => {
    await db.insert(tenantApiKeys).values({
      id: "tk-1",
      tenantId: "tenant-a",
      provider: "anthropic",
      label: "Test",
      encryptedKey: "sk-ant-api12345678901234567890",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const findings = await auditCredentialEncryption(db);
    expect(findings).toHaveLength(1);
    expect(findings[0].table).toBe("tenant_api_keys");
    expect(findings[0].rowId).toBe("tk-1");
  });
});

describe("migratePlaintextCredentials", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let vaultKey: Buffer;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    pool = testDb.pool;
    vaultKey = generateInstanceKey();
  });

  afterEach(async () => {
    await pool.close();
  });

  it("skips already-encrypted rows", async () => {
    const encrypted = JSON.stringify(encrypt("sk-ant-test", vaultKey));
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "anthropic",
      keyName: "Test",
      encryptedValue: encrypted,
      authType: "header",
      createdBy: "admin",
    });

    const results = await migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].migratedCount).toBe(0);
    expect(results[0].errors).toHaveLength(0);
  });

  it("encrypts plaintext rows", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "anthropic",
      keyName: "Test",
      encryptedValue: "sk-ant-plaintext-key-1234567890",
      authType: "header",
      createdBy: "admin",
    });

    const results = await migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].migratedCount).toBe(1);

    // Verify the value is now encrypted JSON
    const rows = await db
      .select({ encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, "cred-1"));
    const parsed = JSON.parse(rows[0].encryptedValue);
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("authTag");
    expect(parsed).toHaveProperty("ciphertext");
  });

  it("handles empty provider_credentials gracefully", async () => {
    // Should not throw when table is empty
    const results = await migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].table).toBe("provider_credentials");
  });

  it("migrates tenant_api_keys when table exists", async () => {
    await db.insert(tenantApiKeys).values({
      id: "tk-1",
      tenantId: "tenant-a",
      provider: "anthropic",
      label: "Test",
      encryptedKey: "sk-ant-plaintext-key-1234567890",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const results = await migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(tenantResult).toBeDefined();
    expect(tenantResult?.migratedCount).toBe(1);
  });

  it("returns table name in results", async () => {
    const results = await migratePlaintextCredentials(db, vaultKey, () => vaultKey);
    expect(results[0].table).toBe("provider_credentials");
  });
});
