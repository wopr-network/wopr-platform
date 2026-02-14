import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminAuditLog } from "../../admin/audit-log.js";
import { createTestDb } from "../../test/db.js";
import { generateInstanceKey } from "../encryption.js";
import { CredentialVaultStore, getVaultEncryptionKey } from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const { db, sqlite } = createTestDb();
  const encryptionKey = generateInstanceKey();
  const auditLog = new AdminAuditLog(db);
  const store = new CredentialVaultStore(db, encryptionKey, auditLog);
  return { sqlite, store, encryptionKey, auditLog };
}

// ---------------------------------------------------------------------------
// CredentialVaultStore
// ---------------------------------------------------------------------------

describe("CredentialVaultStore", () => {
  let sqlite: Database.Database;
  let store: CredentialVaultStore;

  beforeEach(() => {
    const s = setup();
    sqlite = s.sqlite;
    store = s.store;
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("create", () => {
    it("returns a UUID for the new credential", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Production",
        plaintextKey: "sk-ant-test-key-123",
        authType: "header",
        authHeader: "x-api-key",
        createdBy: "admin-1",
      });
      expect(id).toBeTruthy();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("encrypts the key before storing", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Production",
        plaintextKey: "sk-ant-test-key-123",
        authType: "header",
        authHeader: "x-api-key",
        createdBy: "admin-1",
      });

      // Read raw from DB — the encrypted_value should NOT contain the plaintext
      const row = sqlite.prepare("SELECT encrypted_value FROM provider_credentials WHERE id = ?").get(id) as {
        encrypted_value: string;
      };
      expect(row.encrypted_value).not.toContain("sk-ant-test-key-123");
      expect(JSON.parse(row.encrypted_value)).toHaveProperty("iv");
      expect(JSON.parse(row.encrypted_value)).toHaveProperty("authTag");
      expect(JSON.parse(row.encrypted_value)).toHaveProperty("ciphertext");
    });

    it("logs an audit entry", () => {
      store.create({
        provider: "openai",
        keyName: "Backup",
        plaintextKey: "sk-test",
        authType: "bearer",
        createdBy: "admin-1",
      });

      const rows = sqlite.prepare("SELECT * FROM admin_audit_log WHERE action = 'credential.create'").all();
      expect(rows).toHaveLength(1);
    });

    it("allows multiple keys per provider", () => {
      store.create({
        provider: "anthropic",
        keyName: "Production",
        plaintextKey: "sk-ant-prod",
        authType: "header",
        authHeader: "x-api-key",
        createdBy: "admin-1",
      });
      store.create({
        provider: "anthropic",
        keyName: "Backup",
        plaintextKey: "sk-ant-backup",
        authType: "header",
        authHeader: "x-api-key",
        createdBy: "admin-1",
      });

      const list = store.list("anthropic");
      expect(list).toHaveLength(2);
    });
  });

  describe("list", () => {
    it("returns empty array when no credentials exist", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns summaries without encrypted values", () => {
      store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "sk-ant-secret",
        authType: "header",
        authHeader: "x-api-key",
        createdBy: "admin-1",
      });

      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0].provider).toBe("anthropic");
      expect(list[0].keyName).toBe("Prod");
      expect(list[0].isActive).toBe(true);
      // Ensure no encrypted value leaks
      expect((list[0] as unknown as Record<string, unknown>).encryptedValue).toBeUndefined();
      expect((list[0] as unknown as Record<string, unknown>).plaintextKey).toBeUndefined();
    });

    it("filters by provider", () => {
      store.create({
        provider: "anthropic",
        keyName: "A",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });
      store.create({
        provider: "openai",
        keyName: "B",
        plaintextKey: "k2",
        authType: "bearer",
        createdBy: "admin-1",
      });

      expect(store.list("anthropic")).toHaveLength(1);
      expect(store.list("openai")).toHaveLength(1);
      expect(store.list("google")).toHaveLength(0);
      expect(store.list()).toHaveLength(2);
    });
  });

  describe("getById", () => {
    it("returns null for non-existent id", () => {
      expect(store.getById("00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("returns the credential summary", () => {
      const id = store.create({
        provider: "openai",
        keyName: "Main",
        plaintextKey: "sk-openai-key",
        authType: "bearer",
        createdBy: "admin-1",
      });

      const cred = store.getById(id);
      expect(cred).not.toBeNull();
      expect(cred?.provider).toBe("openai");
      expect(cred?.keyName).toBe("Main");
      expect(cred?.authType).toBe("bearer");
      expect(cred?.isActive).toBe(true);
      expect(cred?.createdBy).toBe("admin-1");
    });
  });

  describe("decrypt", () => {
    it("returns null for non-existent id", () => {
      expect(store.decrypt("00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("decrypts the stored key correctly", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "sk-ant-my-real-key-12345",
        authType: "header",
        authHeader: "x-api-key",
        createdBy: "admin-1",
      });

      const decrypted = store.decrypt(id);
      expect(decrypted).not.toBeNull();
      expect(decrypted?.plaintextKey).toBe("sk-ant-my-real-key-12345");
      expect(decrypted?.provider).toBe("anthropic");
      expect(decrypted?.authType).toBe("header");
      expect(decrypted?.authHeader).toBe("x-api-key");
    });
  });

  describe("getActiveForProvider", () => {
    it("returns empty array when no active keys exist", () => {
      expect(store.getActiveForProvider("anthropic")).toEqual([]);
    });

    it("returns only active credentials", () => {
      store.create({
        provider: "anthropic",
        keyName: "Active",
        plaintextKey: "sk-ant-active",
        authType: "header",
        createdBy: "admin-1",
      });
      const id2 = store.create({
        provider: "anthropic",
        keyName: "Inactive",
        plaintextKey: "sk-ant-inactive",
        authType: "header",
        createdBy: "admin-1",
      });

      store.setActive(id2, false, "admin-1");

      const active = store.getActiveForProvider("anthropic");
      expect(active).toHaveLength(1);
      expect(active[0].plaintextKey).toBe("sk-ant-active");
    });

    it("does not return credentials for other providers", () => {
      store.create({
        provider: "anthropic",
        keyName: "A",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });
      store.create({
        provider: "openai",
        keyName: "B",
        plaintextKey: "k2",
        authType: "bearer",
        createdBy: "admin-1",
      });

      const anthropicKeys = store.getActiveForProvider("anthropic");
      expect(anthropicKeys).toHaveLength(1);
      expect(anthropicKeys[0].provider).toBe("anthropic");
    });
  });

  describe("rotate", () => {
    it("returns false for non-existent credential", () => {
      expect(
        store.rotate({
          id: "00000000-0000-0000-0000-000000000000",
          plaintextKey: "new-key",
          rotatedBy: "admin-1",
        }),
      ).toBe(false);
    });

    it("replaces the encrypted key value", () => {
      const id = store.create({
        provider: "openai",
        keyName: "Prod",
        plaintextKey: "sk-old-key",
        authType: "bearer",
        createdBy: "admin-1",
      });

      const ok = store.rotate({
        id,
        plaintextKey: "sk-new-key",
        rotatedBy: "admin-1",
      });
      expect(ok).toBe(true);

      const decrypted = store.decrypt(id);
      expect(decrypted?.plaintextKey).toBe("sk-new-key");
    });

    it("sets the rotatedAt timestamp", () => {
      const id = store.create({
        provider: "openai",
        keyName: "Prod",
        plaintextKey: "sk-old",
        authType: "bearer",
        createdBy: "admin-1",
      });

      const before = store.getById(id);
      expect(before?.rotatedAt).toBeNull();

      store.rotate({ id, plaintextKey: "sk-new", rotatedBy: "admin-1" });

      const after = store.getById(id);
      expect(after?.rotatedAt).not.toBeNull();
    });

    it("logs an audit entry", () => {
      const id = store.create({
        provider: "openai",
        keyName: "Prod",
        plaintextKey: "sk-old",
        authType: "bearer",
        createdBy: "admin-1",
      });

      store.rotate({ id, plaintextKey: "sk-new", rotatedBy: "admin-2" });

      const rows = sqlite.prepare("SELECT * FROM admin_audit_log WHERE action = 'credential.rotate'").all();
      expect(rows).toHaveLength(1);
    });
  });

  describe("setActive", () => {
    it("returns false for non-existent credential", () => {
      expect(store.setActive("00000000-0000-0000-0000-000000000000", false, "admin-1")).toBe(false);
    });

    it("deactivates a credential", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });

      expect(store.setActive(id, false, "admin-1")).toBe(true);
      expect(store.getById(id)?.isActive).toBe(false);
    });

    it("reactivates a credential", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });

      store.setActive(id, false, "admin-1");
      store.setActive(id, true, "admin-1");
      expect(store.getById(id)?.isActive).toBe(true);
    });

    it("logs audit entries for activate and deactivate", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });

      store.setActive(id, false, "admin-1");
      store.setActive(id, true, "admin-1");

      const deactivate = sqlite.prepare("SELECT * FROM admin_audit_log WHERE action = 'credential.deactivate'").all();
      const activate = sqlite.prepare("SELECT * FROM admin_audit_log WHERE action = 'credential.activate'").all();
      expect(deactivate).toHaveLength(1);
      expect(activate).toHaveLength(1);
    });
  });

  describe("markValidated", () => {
    it("returns false for non-existent credential", () => {
      expect(store.markValidated("00000000-0000-0000-0000-000000000000")).toBe(false);
    });

    it("sets the lastValidated timestamp", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });

      expect(store.getById(id)?.lastValidated).toBeNull();
      expect(store.markValidated(id)).toBe(true);
      expect(store.getById(id)?.lastValidated).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("returns false for non-existent credential", () => {
      expect(store.delete("00000000-0000-0000-0000-000000000000", "admin-1")).toBe(false);
    });

    it("removes the credential", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });

      expect(store.delete(id, "admin-1")).toBe(true);
      expect(store.getById(id)).toBeNull();
      expect(store.list()).toHaveLength(0);
    });

    it("logs an audit entry", () => {
      const id = store.create({
        provider: "anthropic",
        keyName: "Prod",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });

      store.delete(id, "admin-2");

      const rows = sqlite.prepare("SELECT * FROM admin_audit_log WHERE action = 'credential.delete'").all();
      expect(rows).toHaveLength(1);
    });
  });

  describe("without audit log", () => {
    it("works without an audit log instance", () => {
      const { db: db2, sqlite: sqlite2 } = createTestDb();
      const encryptionKey = generateInstanceKey();
      const storeNoAudit = new CredentialVaultStore(db2, encryptionKey);

      const id = storeNoAudit.create({
        provider: "anthropic",
        keyName: "Test",
        plaintextKey: "k1",
        authType: "header",
        createdBy: "admin-1",
      });

      expect(id).toBeTruthy();
      expect(storeNoAudit.getById(id)).not.toBeNull();
      sqlite2.close();
    });
  });
});

// ---------------------------------------------------------------------------
// getVaultEncryptionKey
// ---------------------------------------------------------------------------

describe("getVaultEncryptionKey", () => {
  it("derives a 32-byte key from a platform secret", () => {
    const key = getVaultEncryptionKey("my-platform-secret");
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("is deterministic for the same secret", () => {
    const a = getVaultEncryptionKey("same-secret");
    const b = getVaultEncryptionKey("same-secret");
    expect(a.equals(b)).toBe(true);
  });

  it("differs for different secrets", () => {
    const a = getVaultEncryptionKey("secret-a");
    const b = getVaultEncryptionKey("secret-b");
    expect(a.equals(b)).toBe(false);
  });

  it("generates a random key when no secret provided", () => {
    const a = getVaultEncryptionKey();
    const b = getVaultEncryptionKey();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });
});
