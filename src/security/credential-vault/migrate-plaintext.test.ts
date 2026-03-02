import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { providerCredentials, tenantApiKeys } from "../../db/schema/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { decrypt, encrypt } from "../encryption.js";
import { migratePlaintextCredentials } from "./migrate-plaintext.js";

describe("migratePlaintextCredentials", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  const vaultKey = crypto.randomBytes(32);
  const tenantKeyDeriver = (_tenantId: string) => crypto.randomBytes(32);

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("returns empty results when no rows exist", async () => {
    const results = await migratePlaintextCredentials(db, vaultKey, tenantKeyDeriver);
    expect(results).toHaveLength(2);
    const provResult = results.find((r) => r.table === "provider_credentials");
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(provResult?.migratedCount).toBe(0);
    expect(tenantResult?.migratedCount).toBe(0);
  });

  it("skips already-encrypted provider credentials", async () => {
    const encrypted = encrypt("my-secret-key", vaultKey);
    await db.insert(providerCredentials).values({
      id: "cred-1",
      provider: "openai",
      keyName: "Production Key",
      encryptedValue: JSON.stringify(encrypted),
      authType: "header",
      createdBy: "admin",
    });

    const results = await migratePlaintextCredentials(db, vaultKey, tenantKeyDeriver);
    const provResult = results.find((r) => r.table === "provider_credentials");
    expect(provResult?.migratedCount).toBe(0);
  });

  it("encrypts plaintext provider credentials", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-2",
      provider: "openai",
      keyName: "Production Key",
      encryptedValue: "sk-plaintext-key-value",
      authType: "header",
      createdBy: "admin",
    });

    const results = await migratePlaintextCredentials(db, vaultKey, tenantKeyDeriver);
    const provResult = results.find((r) => r.table === "provider_credentials");
    expect(provResult?.migratedCount).toBe(1);
    expect(provResult?.errors).toHaveLength(0);

    const rows = await db.select().from(providerCredentials);
    const parsed = JSON.parse(rows[0].encryptedValue);
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("authTag");
    expect(parsed).toHaveProperty("ciphertext");

    const decrypted = decrypt(parsed, vaultKey);
    expect(decrypted).toBe("sk-plaintext-key-value");
  });

  it("skips empty provider credential values", async () => {
    await db.insert(providerCredentials).values({
      id: "cred-3",
      provider: "openai",
      keyName: "Empty Key",
      encryptedValue: "   ",
      authType: "header",
      createdBy: "admin",
    });

    const results = await migratePlaintextCredentials(db, vaultKey, tenantKeyDeriver);
    const provResult = results.find((r) => r.table === "provider_credentials");
    expect(provResult?.migratedCount).toBe(0);
  });

  it("encrypts plaintext tenant API keys", async () => {
    const stableKey = crypto.randomBytes(32);
    const stableDeriver = (_tenantId: string) => stableKey;
    const now = Date.now();

    await db.insert(tenantApiKeys).values({
      id: "key-1",
      tenantId: "t-1",
      provider: "openai",
      encryptedKey: "plaintext-tenant-key",
      label: "test key",
      createdAt: now,
      updatedAt: now,
    });

    const results = await migratePlaintextCredentials(db, vaultKey, stableDeriver);
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(tenantResult?.migratedCount).toBe(1);

    const rows = await db.select().from(tenantApiKeys);
    const parsed = JSON.parse(rows[0].encryptedKey);
    expect(parsed).toHaveProperty("iv");
    const decrypted = decrypt(parsed, stableKey);
    expect(decrypted).toBe("plaintext-tenant-key");
  });

  it("skips already-encrypted tenant API keys", async () => {
    const stableKey = crypto.randomBytes(32);
    const encrypted = encrypt("my-key", stableKey);
    const now = Date.now();

    await db.insert(tenantApiKeys).values({
      id: "key-2",
      tenantId: "t-1",
      provider: "anthropic",
      encryptedKey: JSON.stringify(encrypted),
      label: "test key",
      createdAt: now,
      updatedAt: now,
    });

    const results = await migratePlaintextCredentials(db, vaultKey, () => stableKey);
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(tenantResult?.migratedCount).toBe(0);
  });

  it("records errors without aborting migration for bad key length", async () => {
    const badKey = crypto.randomBytes(16); // wrong length — encrypt() will throw

    await db.insert(providerCredentials).values({
      id: "cred-err",
      provider: "openai",
      keyName: "Error Key",
      encryptedValue: "plaintext-value",
      authType: "header",
      createdBy: "admin",
    });

    const results = await migratePlaintextCredentials(db, badKey, tenantKeyDeriver);
    const provResult = results.find((r) => r.table === "provider_credentials");
    expect(provResult?.migratedCount).toBe(0);
    expect(provResult?.errors).toHaveLength(1);
    expect(provResult?.errors[0]).toContain("cred-err");
  });
});
