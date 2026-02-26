import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { notificationQueue } from "../db/schema/notification-queue.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { NotificationQueueStore } from "./notification-queue-store.js";

describe("NotificationQueueStore", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: NotificationQueueStore;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new NotificationQueueStore(db);
  });

  describe("enqueue", () => {
    it("creates a pending notification row", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", { email: "user@example.com" });
      expect(id).toBeTruthy();

      const rows = await db.select().from(notificationQueue);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].tenantId).toBe("tenant-1");
      // emailType stores the template name
      expect(rows[0].emailType).toBe("low-balance");
      expect(rows[0].status).toBe("pending");
      expect(rows[0].attempts).toBe(0);
    });

    it("serializes data as JSON payload", async () => {
      await store.enqueue("tenant-1", "low-balance", { email: "a@b.com", amount: 42 });
      const rows = await db.select().from(notificationQueue);
      expect(JSON.parse(rows[0].payload)).toEqual({ email: "a@b.com", amount: 42 });
    });

    it("returns a unique ID each call", async () => {
      const id1 = await store.enqueue("tenant-1", "low-balance", {});
      const id2 = await store.enqueue("tenant-1", "low-balance", {});
      expect(id1).not.toBe(id2);
    });

    it("exposes template via QueuedNotification interface", async () => {
      await store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      const pending = await store.fetchPending(10);
      expect(pending[0].template).toBe("low-balance");
    });

    it("exposes data via QueuedNotification interface", async () => {
      await store.enqueue("tenant-1", "low-balance", { email: "a@b.com", amount: 42 });
      const pending = await store.fetchPending(10);
      expect(JSON.parse(pending[0].data)).toEqual({ email: "a@b.com", amount: 42 });
    });
  });

  describe("fetchPending", () => {
    it("returns pending notifications", async () => {
      await store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      const pending = await store.fetchPending(10);
      expect(pending).toHaveLength(1);
      expect(pending[0].template).toBe("low-balance");
    });

    it("does not return sent notifications", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      await store.markSent(id);
      const pending = await store.fetchPending(10);
      expect(pending).toHaveLength(0);
    });

    it("does not return permanently failed notifications", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      // 5 attempts = permanently failed
      await store.markFailed(id, 5);
      const pending = await store.fetchPending(10);
      expect(pending).toHaveLength(0);
    });

    it("respects limit parameter", async () => {
      await store.enqueue("tenant-1", "low-balance", {});
      await store.enqueue("tenant-1", "low-balance", {});
      await store.enqueue("tenant-1", "low-balance", {});
      const pending = await store.fetchPending(2);
      expect(pending).toHaveLength(2);
    });
  });

  describe("markSent", () => {
    it("transitions status to sent and sets sentAt", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", {});
      const before = Date.now();
      await store.markSent(id);
      const after = Date.now();

      const rows = await db.select().from(notificationQueue);
      expect(rows[0].status).toBe("sent");
      expect(rows[0].sentAt).toBeGreaterThanOrEqual(before);
      expect(rows[0].sentAt).toBeLessThanOrEqual(after);
    });
  });

  describe("markFailed", () => {
    it("increments attempts and applies exponential backoff for first failure", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", {});
      const before = Date.now();
      await store.markFailed(id, 1);
      const after = Date.now();

      const rows = await db.select().from(notificationQueue);
      expect(rows[0].attempts).toBe(1);
      // 1st attempt: 60s * 2^1 = 120s backoff
      const expectedBackoff = 60_000 * 2 ** 1;
      expect(rows[0].retryAfter).toBeGreaterThanOrEqual(before + expectedBackoff - 100);
      expect(rows[0].retryAfter).toBeLessThanOrEqual(after + expectedBackoff + 100);
    });

    it("caps backoff at 1 hour", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", {});
      await store.markFailed(id, 4);

      const rows = await db.select().from(notificationQueue);
      // backoff = 60_000 * 2^4 = 960_000ms > 3_600_000ms cap
      const maxBackoff = 3_600_000;
      expect(rows[0].retryAfter).toBeLessThanOrEqual(Date.now() + maxBackoff + 1000);
    });

    it("permanently fails after 5 attempts", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", {});
      await store.markFailed(id, 5);

      const rows = await db.select().from(notificationQueue);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].attempts).toBe(5);
    });

    it("keeps status as pending with retry for attempts below 5", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", {});
      await store.markFailed(id, 3);

      const rows = await db.select().from(notificationQueue);
      expect(rows[0].status).toBe("pending");
    });
  });

  describe("listForTenant", () => {
    it("returns notifications for the given tenant", async () => {
      await store.enqueue("tenant-1", "low-balance", {});
      await store.enqueue("tenant-2", "low-balance", {});
      await store.enqueue("tenant-1", "welcome", {});

      const result = await store.listForTenant("tenant-1");
      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("returns most recent first (ordered by createdAt desc)", async () => {
      const id1 = await store.enqueue("tenant-1", "template-a", {});
      const id2 = await store.enqueue("tenant-1", "template-b", {});

      // Force distinct timestamps so ordering is deterministic
      await db.update(notificationQueue).set({ createdAt: 1000 }).where(eq(notificationQueue.id, id1));
      await db.update(notificationQueue).set({ createdAt: 2000 }).where(eq(notificationQueue.id, id2));

      const result = await store.listForTenant("tenant-1");
      // Most recent (id2, createdAt=2000) should be first
      expect(result.entries[0].id).toBe(id2);
      expect(result.entries[1].id).toBe(id1);
    });

    it("paginates results", async () => {
      await store.enqueue("tenant-1", "template-a", {});
      await store.enqueue("tenant-1", "template-b", {});
      await store.enqueue("tenant-1", "template-c", {});

      const page1 = await store.listForTenant("tenant-1", { limit: 2, offset: 0 });
      expect(page1.entries).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await store.listForTenant("tenant-1", { limit: 2, offset: 2 });
      expect(page2.entries).toHaveLength(1);
    });

    it("filters by status", async () => {
      const id = await store.enqueue("tenant-1", "low-balance", {});
      await store.enqueue("tenant-1", "welcome", {});
      await store.markSent(id);

      const sent = await store.listForTenant("tenant-1", { status: "sent" });
      expect(sent.entries).toHaveLength(1);
      expect(sent.entries[0].status).toBe("sent");

      const pending = await store.listForTenant("tenant-1", { status: "pending" });
      expect(pending.entries).toHaveLength(1);
    });

    it("returns empty for unknown tenant", async () => {
      const result = await store.listForTenant("nonexistent");
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });
});
