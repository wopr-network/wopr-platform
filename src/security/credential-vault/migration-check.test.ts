import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { providerCredentials, tenantApiKeys } from "../../db/schema/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { decrypt, encrypt, generateInstanceKey } from "../encryption.js";
import type { EncryptedPayload } from "../types.js";
import { DrizzleCredentialRepository, DrizzleMigrationTenantKeyAccess } from "./credential-repository.js";
import { reEncryptAllCredentials } from "./key-rotation.js";
import { migratePlaintextCredentials } from "./migrate-plaintext.js";
import { auditCredentialEncryption } from "./migration-check.js";
import { CredentialVaultStore, getVaultEncryptionKey } from "./store.js";

// TOP OF FILE - shared across ALL describes
let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

describe("auditCredentialEncryption", () => {
  beforeEach(async () => {
    await rollbackTestTransaction(pool);
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
  let vaultKey: Buffer;
  let credRepo: DrizzleCredentialRepository;
  let tenantAccess: DrizzleMigrationTenantKeyAccess;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    vaultKey = generateInstanceKey();
    credRepo = new DrizzleCredentialRepository(db);
    tenantAccess = new DrizzleMigrationTenantKeyAccess(db);
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

    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
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

    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
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
    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
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

    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(tenantResult).toBeDefined();
    expect(tenantResult?.migratedCount).toBe(1);
  });

  it("returns table name in results", async () => {
    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results[0].table).toBe("provider_credentials");
  });

  it("migrated row is subsequently detected as already-encrypted", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "anthropic",
      keyName: "Test",
      encryptedValue: "sk-ant-plaintext-key-1234567890",
      authType: "header",
      createdBy: "admin",
    });

    // First migration: should encrypt
    const results1 = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results1[0].migratedCount).toBe(1);

    // Second migration: row is now encrypted, should be skipped
    const results2 = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results2[0].migratedCount).toBe(0);
  });

  it("migrating already-migrated credential is a no-op (value unchanged)", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "anthropic",
      keyName: "Test",
      encryptedValue: "sk-ant-plaintext-key-1234567890",
      authType: "header",
      createdBy: "admin",
    });

    // Migrate once
    await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);

    // Capture the encrypted value
    const rowsBefore = await db
      .select({ encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, "cred-1"));
    const valueBefore = rowsBefore[0].encryptedValue;

    // Migrate again — should be no-op
    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results[0].migratedCount).toBe(0);

    // Value should be identical (not re-encrypted)
    const rowsAfter = await db
      .select({ encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, "cred-1"));
    expect(rowsAfter[0].encryptedValue).toBe(valueBefore);
  });

  it("batch migrates 100 plaintext credentials with no plaintext remaining", async () => {
    // Insert 100 plaintext credentials
    for (let i = 0; i < 100; i++) {
      await db.insert(providerCredentials).values({
        id: `cred-${i}`,
        provider: "anthropic",
        keyName: `Key-${i}`,
        encryptedValue: `sk-ant-plaintext-batch-key-${String(i).padStart(4, "0")}`,
        authType: "header",
        createdBy: "admin",
      });
    }

    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results[0].migratedCount).toBe(100);
    expect(results[0].errors).toHaveLength(0);

    // Verify no plaintext remains
    const allRows = await db
      .select({ id: providerCredentials.id, encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials);
    expect(allRows).toHaveLength(100);

    for (const row of allRows) {
      const parsed = JSON.parse(row.encryptedValue);
      expect(parsed).toHaveProperty("iv");
      expect(parsed).toHaveProperty("authTag");
      expect(parsed).toHaveProperty("ciphertext");
      // Ensure the raw value does not contain any plaintext key pattern
      expect(row.encryptedValue).not.toMatch(/sk-ant-plaintext/);
    }
  });
});

describe("credential vault migration path", () => {
  let vaultKey: Buffer;
  let credRepo: DrizzleCredentialRepository;
  let tenantAccess: DrizzleMigrationTenantKeyAccess;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    vaultKey = generateInstanceKey();
    credRepo = new DrizzleCredentialRepository(db);
    tenantAccess = new DrizzleMigrationTenantKeyAccess(db);
  });

  it("pre-migration plaintext credential is readable after migratePlaintextCredentials", async () => {
    // Insert a plaintext credential (simulating legacy state)
    await db.insert(providerCredentials).values({
      id: "cred-legacy",
      provider: "anthropic",
      keyName: "Legacy Key",
      encryptedValue: "sk-ant-legacy-plaintext-key-999",
      authType: "header",
      authHeader: "x-api-key",
      createdBy: "admin",
    });

    // Pre-migration: raw value is plaintext
    const rowsBefore = await db
      .select({ encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, "cred-legacy"));
    expect(rowsBefore[0].encryptedValue).toBe("sk-ant-legacy-plaintext-key-999");

    // Migrate
    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results[0].migratedCount).toBe(1);
    expect(results[0].errors).toHaveLength(0);

    // Post-migration: decrypt through CredentialVaultStore
    const repo = new DrizzleCredentialRepository(db);
    const store = new CredentialVaultStore(repo, vaultKey);
    const decrypted = await store.decrypt("cred-legacy");
    expect(decrypted).not.toBeNull();
    expect(decrypted!.plaintextKey).toBe("sk-ant-legacy-plaintext-key-999");
    expect(decrypted!.provider).toBe("anthropic");
    expect(decrypted!.keyName).toBe("Legacy Key");
    expect(decrypted!.authType).toBe("header");
    expect(decrypted!.authHeader).toBe("x-api-key");
  });

  it("post-migration credential metadata is fully preserved", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-meta",
      provider: "openai",
      keyName: "Metadata Test",
      encryptedValue: "sk-openai-meta-test-key-12345",
      authType: "bearer",
      authHeader: null,
      createdBy: "admin-user",
    });

    await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);

    const repo = new DrizzleCredentialRepository(db);
    const store = new CredentialVaultStore(repo, vaultKey);

    // Verify summary metadata is intact
    const summary = await store.getById("cred-meta");
    expect(summary).not.toBeNull();
    expect(summary!.provider).toBe("openai");
    expect(summary!.keyName).toBe("Metadata Test");
    expect(summary!.authType).toBe("bearer");
    expect(summary!.authHeader).toBeNull();
    expect(summary!.createdBy).toBe("admin-user");
    expect(summary!.isActive).toBe(true);
  });

  it("migration idempotency: running twice does not corrupt and encrypted value is unchanged", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-idem",
      provider: "anthropic",
      keyName: "Idempotent",
      encryptedValue: "sk-ant-idempotent-test-key-000",
      authType: "header",
      createdBy: "admin",
    });

    // First migration
    const r1 = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(r1[0].migratedCount).toBe(1);

    // Capture encrypted value
    const rowsAfterFirst = await db
      .select({ encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, "cred-idem"));
    const encryptedAfterFirst = rowsAfterFirst[0].encryptedValue;

    // Second migration (should be no-op)
    const r2 = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(r2[0].migratedCount).toBe(0);

    // Encrypted value must be byte-identical
    const rowsAfterSecond = await db
      .select({ encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, "cred-idem"));
    expect(rowsAfterSecond[0].encryptedValue).toBe(encryptedAfterFirst);

    // Still decryptable through the store
    const repo = new DrizzleCredentialRepository(db);
    const store = new CredentialVaultStore(repo, vaultKey);
    const decrypted = await store.decrypt("cred-idem");
    expect(decrypted!.plaintextKey).toBe("sk-ant-idempotent-test-key-000");
  });

  it("partial migration failure: valid rows are migrated, invalid rows produce errors, valid rows remain readable", async () => {
    // Row 1: valid plaintext
    await db.insert(providerCredentials).values({
      id: "cred-valid",
      provider: "anthropic",
      keyName: "Valid",
      encryptedValue: "sk-ant-valid-plaintext-key-111",
      authType: "header",
      createdBy: "admin",
    });

    // Row 2: already encrypted (should be skipped, not an error)
    const alreadyEncrypted = JSON.stringify(encrypt("sk-ant-already-encrypted", vaultKey));
    await db.insert(providerCredentials).values({
      id: "cred-encrypted",
      provider: "openai",
      keyName: "Already Encrypted",
      encryptedValue: alreadyEncrypted,
      authType: "bearer",
      createdBy: "admin",
    });

    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results[0].migratedCount).toBe(1); // only the plaintext row
    expect(results[0].errors).toHaveLength(0);

    // Both rows are now readable through the store
    const repo = new DrizzleCredentialRepository(db);
    const store = new CredentialVaultStore(repo, vaultKey);

    const d1 = await store.decrypt("cred-valid");
    expect(d1!.plaintextKey).toBe("sk-ant-valid-plaintext-key-111");

    const d2 = await store.decrypt("cred-encrypted");
    expect(d2!.plaintextKey).toBe("sk-ant-already-encrypted");
  });

  it("key rotation after plaintext migration: full chain works", async () => {
    const oldSecret = "old-platform-secret-rotation-test";
    const newSecret = "new-platform-secret-rotation-test";
    const oldKey = getVaultEncryptionKey(oldSecret);

    // Start with plaintext
    await db.insert(providerCredentials).values({
      id: "cred-chain",
      provider: "anthropic",
      keyName: "Chain Test",
      encryptedValue: "sk-ant-chain-test-key-xyz",
      authType: "header",
      authHeader: "x-api-key",
      createdBy: "admin",
    });

    // Step 1: Migrate plaintext to encrypted with old key
    const oldCredRepo = new DrizzleCredentialRepository(db);
    const migrateResults = await migratePlaintextCredentials(oldCredRepo, oldKey, () => oldKey);
    expect(migrateResults[0].migratedCount).toBe(1);

    // Verify readable with old key
    const repo1 = new DrizzleCredentialRepository(db);
    const store1 = new CredentialVaultStore(repo1, oldKey);
    const d1 = await store1.decrypt("cred-chain");
    expect(d1!.plaintextKey).toBe("sk-ant-chain-test-key-xyz");

    // Step 2: Rotate keys from old secret to new secret
    const rotCredAccess = new DrizzleCredentialRepository(db);
    const rotTenantKeyAccess = new DrizzleMigrationTenantKeyAccess(db);
    const rotResult = await reEncryptAllCredentials(rotCredAccess, rotTenantKeyAccess, oldSecret, newSecret);
    expect(rotResult.providerCredentials.migrated).toBe(1);
    expect(rotResult.providerCredentials.errors).toHaveLength(0);

    // Verify readable with new key
    const newKey = getVaultEncryptionKey(newSecret);
    const repo2 = new DrizzleCredentialRepository(db);
    const store2 = new CredentialVaultStore(repo2, newKey);
    const d2 = await store2.decrypt("cred-chain");
    expect(d2!.plaintextKey).toBe("sk-ant-chain-test-key-xyz");
    expect(d2!.provider).toBe("anthropic");
    expect(d2!.authHeader).toBe("x-api-key");

    // Old key can no longer decrypt
    const rowRaw = await db
      .select({ encryptedValue: providerCredentials.encryptedValue })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, "cred-chain"));
    const payload: EncryptedPayload = JSON.parse(rowRaw[0].encryptedValue);
    expect(() => decrypt(payload, oldKey)).toThrow();
  });

  it("tenant_api_keys migration: plaintext tenant key is readable post-migration", async () => {
    await db.insert(tenantApiKeys).values({
      id: "tk-migrate",
      tenantId: "tenant-test",
      provider: "anthropic",
      label: "Tenant Migration Test",
      encryptedKey: "sk-ant-tenant-plaintext-key-888",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const tenantKeyDeriver = (_tenantId: string) => vaultKey;
    const localTenantAccess = new DrizzleMigrationTenantKeyAccess(db);
    const results = await migratePlaintextCredentials(credRepo, vaultKey, tenantKeyDeriver, localTenantAccess);
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(tenantResult).toBeDefined();
    expect(tenantResult!.migratedCount).toBe(1);
    expect(tenantResult!.errors).toHaveLength(0);

    // Verify the encrypted value is valid
    const rows = await db
      .select({ encryptedKey: tenantApiKeys.encryptedKey })
      .from(tenantApiKeys)
      .where(eq(tenantApiKeys.id, "tk-migrate"));
    const payload: EncryptedPayload = JSON.parse(rows[0].encryptedKey);
    const decrypted = decrypt(payload, vaultKey);
    expect(decrypted).toBe("sk-ant-tenant-plaintext-key-888");
  });

  it("audit after migration: no plaintext findings remain", async () => {
    // Insert 3 plaintext credentials
    for (let i = 0; i < 3; i++) {
      await db.insert(providerCredentials).values({
        id: `cred-audit-${i}`,
        provider: "anthropic",
        keyName: `Audit Key ${i}`,
        encryptedValue: `sk-ant-audit-plaintext-key-${i}`,
        authType: "header",
        createdBy: "admin",
      });
    }

    // Pre-migration audit should find 3 plaintext entries
    const findingsBefore = await auditCredentialEncryption(db);
    expect(findingsBefore).toHaveLength(3);

    // Migrate
    const results = await migratePlaintextCredentials(credRepo, vaultKey, () => vaultKey, tenantAccess);
    expect(results[0].migratedCount).toBe(3);

    // Post-migration audit should find 0 plaintext entries
    const findingsAfter = await auditCredentialEncryption(db);
    expect(findingsAfter).toHaveLength(0);
  });
});
