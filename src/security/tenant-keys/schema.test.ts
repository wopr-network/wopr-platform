import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EncryptedPayload } from "../types.js";
import { initTenantKeySchema, TenantKeyStore } from "./schema.js";

function freshDb(): BetterSqlite3.Database {
  return new BetterSqlite3(":memory:");
}

function tableNames(db: BetterSqlite3.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
  ).map((r) => r.name);
}

function indexNames(db: BetterSqlite3.Database, prefix: string): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?").all(`${prefix}%`) as {
      name: string;
    }[]
  ).map((r) => r.name);
}

const fakeEncrypted: EncryptedPayload = {
  iv: "aabbccdd",
  authTag: "11223344",
  ciphertext: "deadbeef",
};

// ---------------------------------------------------------------------------
// initTenantKeySchema
// ---------------------------------------------------------------------------

describe("initTenantKeySchema", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = freshDb();
    initTenantKeySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates the tenant_api_keys table", () => {
    expect(tableNames(db)).toContain("tenant_api_keys");
  });

  it("creates expected indexes", () => {
    const idxs = indexNames(db, "idx_tenant_keys_");
    expect(idxs).toContain("idx_tenant_keys_tenant_provider");
    expect(idxs).toContain("idx_tenant_keys_tenant");
    expect(idxs).toContain("idx_tenant_keys_provider");
  });

  it("is idempotent", () => {
    initTenantKeySchema(db);
    initTenantKeySchema(db);
    expect(tableNames(db).filter((t) => t === "tenant_api_keys")).toHaveLength(1);
  });

  it("enforces NOT NULL on tenant_id", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("k1", null, "anthropic", "", "{}", Date.now(), Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on provider", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("k1", "t1", null, "", "{}", Date.now(), Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on encrypted_key", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("k1", "t1", "anthropic", "", null, Date.now(), Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on created_at", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("k1", "t1", "anthropic", "", "{}", null, Date.now()),
    ).toThrow();
  });

  it("enforces NOT NULL on updated_at", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("k1", "t1", "anthropic", "", "{}", Date.now(), null),
    ).toThrow();
  });

  it("enforces PRIMARY KEY uniqueness on id", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("dup-id", "t1", "anthropic", "", "{}", now, now);

    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("dup-id", "t2", "openai", "", "{}", now, now),
    ).toThrow();
  });

  it("enforces UNIQUE on (tenant_id, provider)", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("k1", "t1", "anthropic", "", "{}", now, now);

    expect(() =>
      db
        .prepare(
          "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("k2", "t1", "anthropic", "", "{}", now, now),
    ).toThrow();
  });

  it("allows different providers for the same tenant", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("k1", "t1", "anthropic", "", "{}", now, now);

    db.prepare(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("k2", "t1", "openai", "", "{}", now, now);

    const count = db.prepare("SELECT COUNT(*) as cnt FROM tenant_api_keys").get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it("allows same provider for different tenants", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("k1", "t1", "anthropic", "", "{}", now, now);

    db.prepare(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, label, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("k2", "t2", "anthropic", "", "{}", now, now);

    const count = db.prepare("SELECT COUNT(*) as cnt FROM tenant_api_keys").get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it("defaults label to empty string", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tenant_api_keys (id, tenant_id, provider, encrypted_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("k1", "t1", "anthropic", "{}", now, now);

    const row = db.prepare("SELECT label FROM tenant_api_keys WHERE id = ?").get("k1") as { label: string };
    expect(row.label).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TenantKeyStore
// ---------------------------------------------------------------------------

describe("TenantKeyStore", () => {
  let db: BetterSqlite3.Database;
  let store: TenantKeyStore;

  beforeEach(() => {
    db = freshDb();
    store = new TenantKeyStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates the table on construction", () => {
    expect(tableNames(db)).toContain("tenant_api_keys");
  });

  describe("upsert", () => {
    it("inserts a new key and returns the id", () => {
      const id = store.upsert("t1", "anthropic", fakeEncrypted, "My Key");
      expect(id).toBeTruthy();

      const record = store.get("t1", "anthropic");
      expect(record).toBeDefined();
      expect(record?.label).toBe("My Key");
      expect(record?.tenant_id).toBe("t1");
      expect(record?.provider).toBe("anthropic");
    });

    it("updates an existing key for the same tenant+provider", () => {
      const id1 = store.upsert("t1", "anthropic", fakeEncrypted, "Old");
      const id2 = store.upsert("t1", "anthropic", { ...fakeEncrypted, ciphertext: "newdata" }, "New");

      // Same ID reused
      expect(id2).toBe(id1);

      const record = store.get("t1", "anthropic");
      expect(record?.label).toBe("New");
      expect(JSON.parse(record!.encrypted_key).ciphertext).toBe("newdata");
    });

    it("sets created_at and updated_at timestamps", () => {
      store.upsert("t1", "openai", fakeEncrypted);
      const record = store.get("t1", "openai");
      expect(record?.created_at).toBeGreaterThan(0);
      expect(record?.updated_at).toBeGreaterThan(0);
    });
  });

  describe("get", () => {
    it("returns undefined for non-existent key", () => {
      expect(store.get("t1", "anthropic")).toBeUndefined();
    });

    it("returns the full record including encrypted_key", () => {
      store.upsert("t1", "anthropic", fakeEncrypted);
      const record = store.get("t1", "anthropic");
      expect(record?.encrypted_key).toBeTruthy();
      const parsed = JSON.parse(record!.encrypted_key);
      expect(parsed.iv).toBe(fakeEncrypted.iv);
      expect(parsed.authTag).toBe(fakeEncrypted.authTag);
      expect(parsed.ciphertext).toBe(fakeEncrypted.ciphertext);
    });
  });

  describe("listForTenant", () => {
    it("returns empty array when tenant has no keys", () => {
      expect(store.listForTenant("t1")).toEqual([]);
    });

    it("returns metadata only (no encrypted_key)", () => {
      store.upsert("t1", "anthropic", fakeEncrypted, "Ant Key");
      store.upsert("t1", "openai", fakeEncrypted, "OAI Key");

      const keys = store.listForTenant("t1");
      expect(keys).toHaveLength(2);

      for (const key of keys) {
        expect(key).not.toHaveProperty("encrypted_key");
        expect(key.tenant_id).toBe("t1");
      }
    });

    it("does not return other tenants' keys", () => {
      store.upsert("t1", "anthropic", fakeEncrypted);
      store.upsert("t2", "openai", fakeEncrypted);

      const keys = store.listForTenant("t1");
      expect(keys).toHaveLength(1);
      expect(keys[0].provider).toBe("anthropic");
    });
  });

  describe("delete", () => {
    it("returns false when no key exists", () => {
      expect(store.delete("t1", "anthropic")).toBe(false);
    });

    it("deletes a key and returns true", () => {
      store.upsert("t1", "anthropic", fakeEncrypted);
      expect(store.delete("t1", "anthropic")).toBe(true);
      expect(store.get("t1", "anthropic")).toBeUndefined();
    });

    it("does not delete other tenants' keys", () => {
      store.upsert("t1", "anthropic", fakeEncrypted);
      store.upsert("t2", "anthropic", fakeEncrypted);

      store.delete("t1", "anthropic");
      expect(store.get("t2", "anthropic")).toBeDefined();
    });
  });

  describe("deleteAllForTenant", () => {
    it("returns 0 when tenant has no keys", () => {
      expect(store.deleteAllForTenant("t1")).toBe(0);
    });

    it("deletes all keys for a tenant", () => {
      store.upsert("t1", "anthropic", fakeEncrypted);
      store.upsert("t1", "openai", fakeEncrypted);
      store.upsert("t2", "anthropic", fakeEncrypted);

      expect(store.deleteAllForTenant("t1")).toBe(2);
      expect(store.listForTenant("t1")).toHaveLength(0);
      expect(store.listForTenant("t2")).toHaveLength(1);
    });
  });
});
