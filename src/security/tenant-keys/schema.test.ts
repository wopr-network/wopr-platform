import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import type { EncryptedPayload } from "../types.js";
import { TenantKeyStore } from "./schema.js";

const fakeEncrypted: EncryptedPayload = {
  iv: "aabbccdd",
  authTag: "11223344",
  ciphertext: "deadbeef",
};

describe("TenantKeyStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: TenantKeyStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new TenantKeyStore(db);
  });

  describe("upsert", () => {
    it("inserts a new key and returns the id", async () => {
      const id = await store.upsert("t1", "anthropic", fakeEncrypted, "My Key");
      expect(id).toBeTruthy();

      const record = await store.get("t1", "anthropic");
      expect(record).toBeDefined();
      expect(record?.label).toBe("My Key");
      expect(record?.tenant_id).toBe("t1");
      expect(record?.provider).toBe("anthropic");
    });

    it("updates an existing key for the same tenant+provider", async () => {
      const id1 = await store.upsert("t1", "anthropic", fakeEncrypted, "Old");
      const id2 = await store.upsert("t1", "anthropic", { ...fakeEncrypted, ciphertext: "newdata" }, "New");

      // Same ID reused
      expect(id2).toBe(id1);

      const record = await store.get("t1", "anthropic");
      expect(record?.label).toBe("New");
      expect(JSON.parse(record?.encrypted_key ?? "{}").ciphertext).toBe("newdata");
    });

    it("sets created_at and updated_at timestamps", async () => {
      await store.upsert("t1", "openai", fakeEncrypted);
      const record = await store.get("t1", "openai");
      expect(record?.created_at).toBeGreaterThan(0);
      expect(record?.updated_at).toBeGreaterThan(0);
    });
  });

  describe("get", () => {
    it("returns undefined for non-existent key", async () => {
      expect(await store.get("t1", "anthropic")).toBeUndefined();
    });

    it("returns the full record including encrypted_key", async () => {
      await store.upsert("t1", "anthropic", fakeEncrypted);
      const record = await store.get("t1", "anthropic");
      expect(record?.encrypted_key).toBeTruthy();
      const parsed = JSON.parse(record?.encrypted_key ?? "{}");
      expect(parsed.iv).toBe(fakeEncrypted.iv);
      expect(parsed.authTag).toBe(fakeEncrypted.authTag);
      expect(parsed.ciphertext).toBe(fakeEncrypted.ciphertext);
    });
  });

  describe("listForTenant", () => {
    it("returns empty array when tenant has no keys", async () => {
      expect(await store.listForTenant("t1")).toEqual([]);
    });

    it("returns metadata only (no encrypted_key)", async () => {
      await store.upsert("t1", "anthropic", fakeEncrypted, "Ant Key");
      await store.upsert("t1", "openai", fakeEncrypted, "OAI Key");

      const keys = await store.listForTenant("t1");
      expect(keys).toHaveLength(2);

      for (const key of keys) {
        expect(key).not.toHaveProperty("encrypted_key");
        expect(key.tenant_id).toBe("t1");
      }
    });

    it("does not return other tenants' keys", async () => {
      await store.upsert("t1", "anthropic", fakeEncrypted);
      await store.upsert("t2", "openai", fakeEncrypted);

      const keys = await store.listForTenant("t1");
      expect(keys).toHaveLength(1);
      expect(keys[0].provider).toBe("anthropic");
    });
  });

  describe("delete", () => {
    it("returns false when no key exists", async () => {
      expect(await store.delete("t1", "anthropic")).toBe(false);
    });

    it("deletes a key and returns true", async () => {
      await store.upsert("t1", "anthropic", fakeEncrypted);
      expect(await store.delete("t1", "anthropic")).toBe(true);
      expect(await store.get("t1", "anthropic")).toBeUndefined();
    });

    it("does not delete other tenants' keys", async () => {
      await store.upsert("t1", "anthropic", fakeEncrypted);
      await store.upsert("t2", "anthropic", fakeEncrypted);

      await store.delete("t1", "anthropic");
      expect(await store.get("t2", "anthropic")).toBeDefined();
    });
  });

  describe("deleteAllForTenant", () => {
    it("returns 0 when tenant has no keys", async () => {
      expect(await store.deleteAllForTenant("t1")).toBe(0);
    });

    it("deletes all keys for a tenant", async () => {
      await store.upsert("t1", "anthropic", fakeEncrypted);
      await store.upsert("t1", "openai", fakeEncrypted);
      await store.upsert("t2", "anthropic", fakeEncrypted);

      expect(await store.deleteAllForTenant("t1")).toBe(2);
      expect(await store.listForTenant("t1")).toHaveLength(0);
      expect(await store.listForTenant("t2")).toHaveLength(1);
    });
  });
});
