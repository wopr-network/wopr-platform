import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../test/db.js";
import { DrizzleExportRepository } from "./export-repository.js";
import { AccountExportStore } from "./export-store.js";

let db: DrizzleDb;
let pool: PGlite;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

describe("AccountExportStore", () => {
  let store: AccountExportStore;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    const repo = new DrizzleExportRepository(db);
    store = new AccountExportStore(repo);
  });

  describe("create()", () => {
    it("creates a pending export request with default format", async () => {
      const req = await store.create("tenant-1", "user-1");
      expect(req.id).toMatch(/^[0-9a-f]{8}-/);
      expect(req.tenantId).toBe("tenant-1");
      expect(req.requestedBy).toBe("user-1");
      expect(req.status).toBe("pending");
      expect(req.format).toBe("json");
      expect(req.downloadUrl).toBeNull();
    });

    it("accepts a custom format", async () => {
      const req = await store.create("tenant-1", "user-1", "csv");
      expect(req.format).toBe("csv");
    });

    it("throws when getById returns null after insert (defensive branch)", async () => {
      const fakeRepo = {
        insert: vi.fn().mockResolvedValue(undefined),
        getById: vi.fn().mockResolvedValue(null),
        list: vi.fn(),
        updateStatus: vi.fn(),
      };
      const fakeStore = new AccountExportStore(fakeRepo as never);
      await expect(fakeStore.create("t", "u")).rejects.toThrow("Failed to retrieve newly created export request");
    });
  });

  describe("list()", () => {
    it("returns empty list when no requests exist", async () => {
      const result = await store.list({ limit: 10, offset: 0 });
      expect(result.requests).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("returns requests with total count", async () => {
      await store.create("tenant-1", "user-1");
      await store.create("tenant-2", "user-2");
      const result = await store.list({ limit: 10, offset: 0 });
      expect(result.requests).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("filters by status", async () => {
      const req = await store.create("tenant-1", "user-1");
      await store.updateStatus(req.id, "completed", "https://example.com/export.zip");
      await store.create("tenant-2", "user-2");

      const pending = await store.list({ status: "pending", limit: 10, offset: 0 });
      expect(pending.requests).toHaveLength(1);
      expect(pending.requests[0].tenantId).toBe("tenant-2");

      const completed = await store.list({ status: "completed", limit: 10, offset: 0 });
      expect(completed.requests).toHaveLength(1);
      expect(completed.requests[0].downloadUrl).toBe("https://example.com/export.zip");
    });

    it("paginates with limit and offset", async () => {
      await store.create("tenant-1", "user-1");
      await store.create("tenant-2", "user-2");
      await store.create("tenant-3", "user-3");

      const page = await store.list({ limit: 2, offset: 0 });
      expect(page.requests).toHaveLength(2);
      expect(page.total).toBe(3);
    });
  });

  describe("updateStatus()", () => {
    it("updates status and downloadUrl", async () => {
      const req = await store.create("tenant-1", "user-1");
      await store.updateStatus(req.id, "completed", "https://example.com/export.zip");
      const updated = await store.getById(req.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.downloadUrl).toBe("https://example.com/export.zip");
    });

    it("updates status without downloadUrl", async () => {
      const req = await store.create("tenant-1", "user-1");
      await store.updateStatus(req.id, "processing");
      const updated = await store.getById(req.id);
      expect(updated?.status).toBe("processing");
      expect(updated?.downloadUrl).toBeNull();
    });
  });
});
