import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import type { InsertCredentialRow } from "./credential-repository.js";
import { DrizzleCredentialRepository } from "./credential-repository.js";

function makeRow(overrides: Partial<InsertCredentialRow> = {}): InsertCredentialRow {
  return {
    id: overrides.id ?? "cred-001",
    provider: overrides.provider ?? "anthropic",
    keyName: overrides.keyName ?? "Production Key",
    encryptedValue: overrides.encryptedValue ?? "enc::cipher::abc123",
    authType: overrides.authType ?? "header",
    authHeader: overrides.authHeader ?? "x-api-key",
    createdBy: overrides.createdBy ?? "admin-1",
    ...overrides,
  };
}

describe("DrizzleCredentialRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleCredentialRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    repo = new DrizzleCredentialRepository(db);
  });

  // --- CRUD: insert + getFullById ---

  describe("insert + getFullById", () => {
    it("inserts a credential and reads it back", async () => {
      const row = makeRow();
      await repo.insert(row);

      const result = await repo.getFullById("cred-001");
      expect(result).not.toBeNull();
      expect(result?.id).toBe("cred-001");
      expect(result?.provider).toBe("anthropic");
      expect(result?.keyName).toBe("Production Key");
      expect(result?.encryptedValue).toBe("enc::cipher::abc123");
      expect(result?.authType).toBe("header");
      expect(result?.authHeader).toBe("x-api-key");
      expect(result?.isActive).toBe(true);
      expect(result?.createdBy).toBe("admin-1");
      expect(result?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/);
    });

    it("returns null for non-existent ID", async () => {
      const result = await repo.getFullById("no-such-id");
      expect(result).toBeNull();
    });
  });

  // --- getSummaryById ---

  describe("getSummaryById", () => {
    it("returns summary without encryptedValue", async () => {
      await repo.insert(makeRow());
      const summary = await repo.getSummaryById("cred-001");

      expect(summary).not.toBeNull();
      expect(summary?.id).toBe("cred-001");
      expect(summary?.provider).toBe("anthropic");
      expect(summary !== null && "encryptedValue" in summary).toBe(false);
    });

    it("returns null for non-existent ID", async () => {
      expect(await repo.getSummaryById("missing")).toBeNull();
    });
  });

  // --- list ---

  describe("list", () => {
    it("lists all credentials as summaries", async () => {
      await repo.insert(makeRow({ id: "c1", provider: "anthropic" }));
      await repo.insert(makeRow({ id: "c2", provider: "openai" }));

      const all = await repo.list();
      expect(all).toHaveLength(2);
      for (const s of all) {
        expect("encryptedValue" in s).toBe(false);
      }
    });

    it("filters by provider", async () => {
      await repo.insert(makeRow({ id: "c1", provider: "anthropic" }));
      await repo.insert(makeRow({ id: "c2", provider: "openai" }));

      const filtered = await repo.list("openai");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].provider).toBe("openai");
    });

    it("returns empty array when no credentials exist", async () => {
      expect(await repo.list()).toEqual([]);
    });
  });

  // --- listActiveForProvider ---

  describe("listActiveForProvider", () => {
    it("returns only active credentials for a provider", async () => {
      await repo.insert(makeRow({ id: "c1", provider: "anthropic" }));
      await repo.insert(makeRow({ id: "c2", provider: "anthropic" }));
      await repo.setActive("c2", false);

      const active = await repo.listActiveForProvider("anthropic");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("c1");
      expect(active[0].encryptedValue).toBe("enc::cipher::abc123");
    });

    it("does not return credentials from other providers", async () => {
      await repo.insert(makeRow({ id: "c1", provider: "anthropic" }));
      await repo.insert(makeRow({ id: "c2", provider: "openai" }));

      const active = await repo.listActiveForProvider("anthropic");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("c1");
    });
  });

  // --- Encryption-at-rest verification ---

  describe("encryption-at-rest", () => {
    it("stores encryptedValue verbatim (round-trip fidelity)", async () => {
      const encryptedValue = "ENCRYPTED::v1::abc123xyz";
      await repo.insert(makeRow({ id: "enc-test", encryptedValue }));

      const result = await repo.getFullById("enc-test");
      expect(result?.encryptedValue).toBe(encryptedValue);
    });

    it("updateEncryptedValue changes the stored ciphertext", async () => {
      await repo.insert(makeRow({ id: "rot-test", encryptedValue: "cipher-v1" }));

      const updated = await repo.updateEncryptedValue("rot-test", "cipher-v2");
      expect(updated).toBe(true);

      const row = await repo.getFullById("rot-test");
      expect(row?.encryptedValue).toBe("cipher-v2");
      expect(row?.rotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/);
    });
  });

  // --- Provider isolation (closest analog to tenant isolation) ---

  describe("provider/creator isolation", () => {
    it("list() with provider filter isolates results", async () => {
      await repo.insert(makeRow({ id: "a1", provider: "anthropic", createdBy: "admin-A" }));
      await repo.insert(makeRow({ id: "o1", provider: "openai", createdBy: "admin-B" }));

      const anthropicCreds = await repo.list("anthropic");
      expect(anthropicCreds).toHaveLength(1);
      expect(anthropicCreds[0].id).toBe("a1");

      const openaiCreds = await repo.list("openai");
      expect(openaiCreds).toHaveLength(1);
      expect(openaiCreds[0].id).toBe("o1");
    });

    it("getFullById only returns exact ID match", async () => {
      await repo.insert(makeRow({ id: "a1", provider: "anthropic" }));
      await repo.insert(makeRow({ id: "o1", provider: "openai" }));

      expect(await repo.getFullById("a1")).not.toBeNull();
      expect(await repo.getFullById("o1")).not.toBeNull();
      expect(await repo.getFullById("a2")).toBeNull();
    });
  });

  // --- deleteById ---

  describe("deleteById", () => {
    it("deletes an existing credential and returns true", async () => {
      await repo.insert(makeRow({ id: "del-1" }));
      expect(await repo.deleteById("del-1")).toBe(true);
      expect(await repo.getFullById("del-1")).toBeNull();
    });

    it("returns false for non-existent ID", async () => {
      expect(await repo.deleteById("no-such")).toBe(false);
    });
  });

  // --- setActive ---

  describe("setActive", () => {
    it("deactivates an active credential", async () => {
      await repo.insert(makeRow({ id: "sa-1" }));
      expect(await repo.setActive("sa-1", false)).toBe(true);

      const row = await repo.getFullById("sa-1");
      expect(row?.isActive).toBe(false);
    });

    it("reactivates a deactivated credential", async () => {
      await repo.insert(makeRow({ id: "sa-2" }));
      await repo.setActive("sa-2", false);
      expect(await repo.setActive("sa-2", true)).toBe(true);

      const row = await repo.getFullById("sa-2");
      expect(row?.isActive).toBe(true);
    });

    it("returns false for non-existent ID", async () => {
      expect(await repo.setActive("missing", false)).toBe(false);
    });
  });

  // --- markValidated ---

  describe("markValidated", () => {
    it("sets lastValidated timestamp", async () => {
      await repo.insert(makeRow({ id: "mv-1" }));
      expect(await repo.markValidated("mv-1")).toBe(true);

      const row = await repo.getFullById("mv-1");
      expect(row?.lastValidated).toMatch(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/);
    });

    it("returns false for non-existent ID", async () => {
      expect(await repo.markValidated("missing")).toBe(false);
    });
  });

  // --- Migration access ---

  describe("listAllWithEncryptedValue", () => {
    it("returns all IDs and encrypted values", async () => {
      await repo.insert(makeRow({ id: "m1", encryptedValue: "ev1" }));
      await repo.insert(makeRow({ id: "m2", encryptedValue: "ev2" }));

      const rows = await repo.listAllWithEncryptedValue();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual(["m1", "m2"]);
      expect(rows.find((r) => r.id === "m1")?.encryptedValue).toBe("ev1");
    });
  });

  describe("updateEncryptedValueOnly", () => {
    it("updates encrypted value without touching rotatedAt", async () => {
      await repo.insert(makeRow({ id: "uev-1", encryptedValue: "old" }));

      await repo.updateEncryptedValueOnly("uev-1", "new");

      const row = await repo.getFullById("uev-1");
      expect(row?.encryptedValue).toBe("new");
      expect(row?.rotatedAt).toBeNull();
    });
  });
});
