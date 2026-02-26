import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleDeletionRepository } from "./deletion-repository.js";
import { AccountDeletionStore, DELETION_GRACE_DAYS } from "./deletion-store.js";

describe("AccountDeletionStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AccountDeletionStore;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    const repo = new DrizzleDeletionRepository(db);
    store = new AccountDeletionStore(repo);
  });

  describe("create()", () => {
    it("throws when getById returns null after insert (defensive branch)", async () => {
      // Mock the repo to simulate a race condition where insert succeeds but getById returns null
      const fakeRepo = {
        insert: vi.fn().mockResolvedValue(undefined),
        getById: vi.fn().mockResolvedValue(null),
        getPendingForTenant: vi.fn(),
        cancel: vi.fn(),
        markCompleted: vi.fn(),
        findExpired: vi.fn(),
      };
      const fakeStore = new AccountDeletionStore(fakeRepo as never);
      await expect(fakeStore.create("tenant-x", "user-x")).rejects.toThrow(
        "Failed to retrieve newly created deletion request",
      );
    });

    it("creates a pending request with correct initial state", async () => {
      const req = await store.create("tenant-1", "user-1");
      expect(req.id).toBeTruthy();
      expect(req.tenantId).toBe("tenant-1");
      expect(req.requestedBy).toBe("user-1");
      expect(req.status).toBe("pending");
      expect(req.cancelReason).toBeNull();
      expect(req.completedAt).toBeNull();
    });

    it("sets deleteAfter approximately 30 days from now", async () => {
      const req = await store.create("tenant-1", "user-1");
      const deleteAfter = new Date(req.deleteAfter);
      const now = new Date();
      const diffDays = (deleteAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      // Allow ±1 day for test timing
      expect(diffDays).toBeGreaterThan(DELETION_GRACE_DAYS - 1);
      expect(diffDays).toBeLessThan(DELETION_GRACE_DAYS + 1);
    });

    it("second request for same tenant works if first was cancelled", async () => {
      const req1 = await store.create("tenant-1", "user-1");
      await store.cancel(req1.id, "Changed my mind");
      const req2 = await store.create("tenant-1", "user-1");
      expect(req2.id).not.toBe(req1.id);
      expect(req2.status).toBe("pending");
    });
  });

  describe("getById()", () => {
    it("returns the request by ID", async () => {
      const req = await store.create("tenant-1", "user-1");
      const found = await store.getById(req.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(req.id);
    });

    it("returns null for nonexistent ID", async () => {
      const result = await store.getById("nonexistent-uuid");
      expect(result).toBeNull();
    });
  });

  describe("getPendingForTenant()", () => {
    it("returns pending request for the tenant", async () => {
      await store.create("tenant-1", "user-1");
      const found = await store.getPendingForTenant("tenant-1");
      expect(found).not.toBeNull();
      expect(found?.tenantId).toBe("tenant-1");
      expect(found?.status).toBe("pending");
    });

    it("returns null when no pending request exists", async () => {
      const result = await store.getPendingForTenant("tenant-no-request");
      expect(result).toBeNull();
    });

    it("returns null after the pending request is cancelled", async () => {
      const req = await store.create("tenant-1", "user-1");
      await store.cancel(req.id, "test reason");
      const result = await store.getPendingForTenant("tenant-1");
      expect(result).toBeNull();
    });
  });

  describe("cancel()", () => {
    it("changes status to cancelled and sets cancelReason", async () => {
      const req = await store.create("tenant-1", "user-1");
      await store.cancel(req.id, "User changed mind");
      const updated = await store.getById(req.id);
      expect(updated?.status).toBe("cancelled");
      expect(updated?.cancelReason).toBe("User changed mind");
    });

    it("does not affect completed requests", async () => {
      const req = await store.create("tenant-1", "user-1");
      await store.markCompleted(req.id, { bot_instances: 2 });
      await store.cancel(req.id, "Late cancel attempt");
      const updated = await store.getById(req.id);
      // Should still be completed — cancel only applies to pending
      expect(updated?.status).toBe("completed");
    });
  });

  describe("markCompleted()", () => {
    it("sets status to completed, stores summary, and sets completedAt", async () => {
      const req = await store.create("tenant-1", "user-1");
      await store.markCompleted(req.id, { bot_instances: 3, credit_transactions: 10 });
      const updated = await store.getById(req.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBeTruthy();
      expect(JSON.parse(updated?.deletionSummary ?? "null")).toEqual({
        bot_instances: 3,
        credit_transactions: 10,
      });
    });
  });

  describe("findExpired()", () => {
    it("returns pending requests whose deleteAfter is in the past", async () => {
      // Directly insert an expired request via raw SQL
      await pool.query(`
        INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
        VALUES ('expired-req', 'tenant-exp', 'user-exp', 'pending', (now() - interval '1 day')::text)
      `);
      const expired = await store.findExpired();
      expect(expired.length).toBeGreaterThanOrEqual(1);
      const found = expired.find((r) => r.id === "expired-req");
      expect(found).toBeTruthy();
    });

    it("does not return pending requests whose deleteAfter is in the future", async () => {
      const req = await store.create("tenant-future", "user-future");
      const expired = await store.findExpired();
      const found = expired.find((r) => r.id === req.id);
      expect(found).toBeUndefined();
    });

    it("does not return cancelled requests even if past deleteAfter", async () => {
      await pool.query(`
        INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
        VALUES ('cancelled-old', 'tenant-c', 'user-c', 'cancelled', (now() - interval '1 day')::text)
      `);
      const expired = await store.findExpired();
      const found = expired.find((r) => r.id === "cancelled-old");
      expect(found).toBeUndefined();
    });

    it("does not return completed requests", async () => {
      await pool.query(`
        INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
        VALUES ('completed-old', 'tenant-done', 'user-done', 'completed', (now() - interval '1 day')::text)
      `);
      const expired = await store.findExpired();
      const found = expired.find((r) => r.id === "completed-old");
      expect(found).toBeUndefined();
    });
  });
});
