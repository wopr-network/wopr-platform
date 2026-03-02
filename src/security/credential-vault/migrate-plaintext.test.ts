import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../encryption.js";
import type { ICredentialRepository } from "./credential-repository.js";
import type { IMigrationTenantKeyAccess } from "./migrate-plaintext.js";
import { migratePlaintextCredentials } from "./migrate-plaintext.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockCredentialRepo(
  rows: Array<{ id: string; encryptedValue: string }> = [],
): ICredentialRepository & { updates: Array<{ id: string; encryptedValue: string }> } {
  const updates: Array<{ id: string; encryptedValue: string }> = [];
  return {
    updates,
    listAllWithEncryptedValue: async () => [...rows],
    updateEncryptedValueOnly: async (id, encryptedValue) => {
      updates.push({ id, encryptedValue });
      // Also update the source array so re-reads see the new value
      const row = rows.find((r) => r.id === id);
      if (row) row.encryptedValue = encryptedValue;
    },
    // Unused methods — satisfy the interface
    insert: async () => {},
    getFullById: async () => null,
    getSummaryById: async () => null,
    list: async () => [],
    listActiveForProvider: async () => [],
    updateEncryptedValue: async () => false,
    setActive: async () => false,
    markValidated: async () => false,
    deleteById: async () => false,
  };
}

function mockTenantKeyAccess(
  rows: Array<{ id: string; tenantId: string; encryptedKey: string }> = [],
): IMigrationTenantKeyAccess & { updates: Array<{ id: string; encryptedKey: string }> } {
  const updates: Array<{ id: string; encryptedKey: string }> = [];
  return {
    updates,
    listAll: async () => [...rows],
    updateEncryptedKey: async (id, encryptedKey) => {
      updates.push({ id, encryptedKey });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migratePlaintextCredentials", () => {
  const vaultKey = crypto.randomBytes(32);
  const tenantKeyDeriver = (_tenantId: string) => crypto.randomBytes(32);

  it("returns empty results when no rows exist", async () => {
    const repo = mockCredentialRepo();
    const tenantAccess = mockTenantKeyAccess();

    const results = await migratePlaintextCredentials(repo, vaultKey, tenantKeyDeriver, tenantAccess);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.table === "provider_credentials")?.migratedCount).toBe(0);
    expect(results.find((r) => r.table === "tenant_api_keys")?.migratedCount).toBe(0);
  });

  it("returns only provider results when no tenant access provided", async () => {
    const repo = mockCredentialRepo();

    const results = await migratePlaintextCredentials(repo, vaultKey, tenantKeyDeriver);
    expect(results).toHaveLength(1);
    expect(results[0].table).toBe("provider_credentials");
  });

  it("skips already-encrypted provider credentials", async () => {
    const encrypted = encrypt("my-secret-key", vaultKey);
    const repo = mockCredentialRepo([{ id: "cred-1", encryptedValue: JSON.stringify(encrypted) }]);

    const results = await migratePlaintextCredentials(repo, vaultKey, tenantKeyDeriver);
    expect(results.find((r) => r.table === "provider_credentials")?.migratedCount).toBe(0);
    expect(repo.updates).toHaveLength(0);
  });

  it("encrypts plaintext provider credentials", async () => {
    const repo = mockCredentialRepo([{ id: "cred-2", encryptedValue: "sk-plaintext-key-value" }]);

    const results = await migratePlaintextCredentials(repo, vaultKey, tenantKeyDeriver);
    const provResult = results.find((r) => r.table === "provider_credentials");
    expect(provResult?.migratedCount).toBe(1);
    expect(provResult?.errors).toHaveLength(0);
    expect(repo.updates).toHaveLength(1);

    const parsed = JSON.parse(repo.updates[0].encryptedValue);
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("authTag");
    expect(parsed).toHaveProperty("ciphertext");
    expect(decrypt(parsed, vaultKey)).toBe("sk-plaintext-key-value");
  });

  it("skips empty provider credential values", async () => {
    const repo = mockCredentialRepo([{ id: "cred-3", encryptedValue: "   " }]);

    const results = await migratePlaintextCredentials(repo, vaultKey, tenantKeyDeriver);
    expect(results.find((r) => r.table === "provider_credentials")?.migratedCount).toBe(0);
    expect(repo.updates).toHaveLength(0);
  });

  it("encrypts plaintext tenant API keys", async () => {
    const stableKey = crypto.randomBytes(32);
    const stableDeriver = (_tenantId: string) => stableKey;
    const tenantAccess = mockTenantKeyAccess([{ id: "key-1", tenantId: "t-1", encryptedKey: "plaintext-tenant-key" }]);
    const repo = mockCredentialRepo();

    const results = await migratePlaintextCredentials(repo, vaultKey, stableDeriver, tenantAccess);
    const tenantResult = results.find((r) => r.table === "tenant_api_keys");
    expect(tenantResult?.migratedCount).toBe(1);
    expect(tenantAccess.updates).toHaveLength(1);

    const parsed = JSON.parse(tenantAccess.updates[0].encryptedKey);
    expect(parsed).toHaveProperty("iv");
    expect(decrypt(parsed, stableKey)).toBe("plaintext-tenant-key");
  });

  it("skips already-encrypted tenant API keys", async () => {
    const stableKey = crypto.randomBytes(32);
    const encrypted = encrypt("my-key", stableKey);
    const tenantAccess = mockTenantKeyAccess([
      { id: "key-2", tenantId: "t-1", encryptedKey: JSON.stringify(encrypted) },
    ]);
    const repo = mockCredentialRepo();

    const results = await migratePlaintextCredentials(repo, vaultKey, () => stableKey, tenantAccess);
    expect(results.find((r) => r.table === "tenant_api_keys")?.migratedCount).toBe(0);
    expect(tenantAccess.updates).toHaveLength(0);
  });

  it("records errors without aborting migration for bad key length", async () => {
    const badKey = crypto.randomBytes(16); // wrong length
    const repo = mockCredentialRepo([{ id: "cred-err", encryptedValue: "plaintext-value" }]);

    const results = await migratePlaintextCredentials(repo, badKey, tenantKeyDeriver);
    const provResult = results.find((r) => r.table === "provider_credentials");
    expect(provResult?.migratedCount).toBe(0);
    expect(provResult?.errors).toHaveLength(1);
    expect(provResult?.errors[0]).toContain("cred-err");
  });
});
