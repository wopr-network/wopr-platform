import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../db/index.js";
import { notificationQueue } from "../db/schema/notification-queue.js";
import { NotificationQueueStore } from "./notification-queue-store.js";

function setupDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  // Mirror the actual schema columns from src/db/schema/notification-queue.ts
  sqlite.exec(`
    CREATE TABLE notification_queue (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      email_type TEXT NOT NULL,
      recipient_email TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_attempt_at INTEGER,
      last_error TEXT,
      retry_after INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      sent_at INTEGER
    );
    CREATE INDEX idx_notif_queue_tenant ON notification_queue(tenant_id);
    CREATE INDEX idx_notif_queue_status ON notification_queue(status);
    CREATE INDEX idx_notif_queue_type ON notification_queue(email_type);
    CREATE INDEX idx_notif_queue_retry ON notification_queue(status, retry_after);
  `);
  return createDb(sqlite);
}

describe("NotificationQueueStore", () => {
  let db: DrizzleDb;
  let store: NotificationQueueStore;

  beforeEach(() => {
    db = setupDb();
    store = new NotificationQueueStore(db);
  });

  describe("enqueue", () => {
    it("creates a pending notification row", () => {
      const id = store.enqueue("tenant-1", "low-balance", { email: "user@example.com" });
      expect(id).toBeTruthy();

      const rows = db.select().from(notificationQueue).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].tenantId).toBe("tenant-1");
      // emailType stores the template name
      expect(rows[0].emailType).toBe("low-balance");
      expect(rows[0].status).toBe("pending");
      expect(rows[0].attempts).toBe(0);
    });

    it("serializes data as JSON payload", () => {
      store.enqueue("tenant-1", "low-balance", { email: "a@b.com", amount: 42 });
      const rows = db.select().from(notificationQueue).all();
      expect(JSON.parse(rows[0].payload)).toEqual({ email: "a@b.com", amount: 42 });
    });

    it("returns a unique ID each call", () => {
      const id1 = store.enqueue("tenant-1", "low-balance", {});
      const id2 = store.enqueue("tenant-1", "low-balance", {});
      expect(id1).not.toBe(id2);
    });

    it("exposes template via QueuedNotification interface", () => {
      store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      const pending = store.fetchPending(10);
      expect(pending[0].template).toBe("low-balance");
    });

    it("exposes data via QueuedNotification interface", () => {
      store.enqueue("tenant-1", "low-balance", { email: "a@b.com", amount: 42 });
      const pending = store.fetchPending(10);
      expect(JSON.parse(pending[0].data)).toEqual({ email: "a@b.com", amount: 42 });
    });
  });

  describe("fetchPending", () => {
    it("returns pending notifications", () => {
      store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      const pending = store.fetchPending(10);
      expect(pending).toHaveLength(1);
      expect(pending[0].template).toBe("low-balance");
    });

    it("does not return sent notifications", () => {
      const id = store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      store.markSent(id);
      const pending = store.fetchPending(10);
      expect(pending).toHaveLength(0);
    });

    it("does not return permanently failed notifications", () => {
      const id = store.enqueue("tenant-1", "low-balance", { email: "a@b.com" });
      // 5 attempts = permanently failed
      store.markFailed(id, 5);
      const pending = store.fetchPending(10);
      expect(pending).toHaveLength(0);
    });

    it("respects limit parameter", () => {
      store.enqueue("tenant-1", "low-balance", {});
      store.enqueue("tenant-1", "low-balance", {});
      store.enqueue("tenant-1", "low-balance", {});
      const pending = store.fetchPending(2);
      expect(pending).toHaveLength(2);
    });
  });

  describe("markSent", () => {
    it("transitions status to sent and sets sentAt", () => {
      const id = store.enqueue("tenant-1", "low-balance", {});
      const before = Date.now();
      store.markSent(id);
      const after = Date.now();

      const rows = db.select().from(notificationQueue).all();
      expect(rows[0].status).toBe("sent");
      expect(rows[0].sentAt).toBeGreaterThanOrEqual(before);
      expect(rows[0].sentAt).toBeLessThanOrEqual(after);
    });
  });

  describe("markFailed", () => {
    it("increments attempts and applies exponential backoff for first failure", () => {
      const id = store.enqueue("tenant-1", "low-balance", {});
      const before = Date.now();
      store.markFailed(id, 1);
      const after = Date.now();

      const rows = db.select().from(notificationQueue).all();
      expect(rows[0].attempts).toBe(1);
      // 1st attempt: 60s * 2^1 = 120s backoff
      const expectedBackoff = 60_000 * 2 ** 1;
      expect(rows[0].retryAfter).toBeGreaterThanOrEqual(before + expectedBackoff - 100);
      expect(rows[0].retryAfter).toBeLessThanOrEqual(after + expectedBackoff + 100);
    });

    it("caps backoff at 1 hour", () => {
      const id = store.enqueue("tenant-1", "low-balance", {});
      store.markFailed(id, 4);

      const rows = db.select().from(notificationQueue).all();
      // backoff = 60_000 * 2^4 = 960_000ms > 3_600_000ms cap
      const maxBackoff = 3_600_000;
      expect(rows[0].retryAfter).toBeLessThanOrEqual(Date.now() + maxBackoff + 1000);
    });

    it("permanently fails after 5 attempts", () => {
      const id = store.enqueue("tenant-1", "low-balance", {});
      store.markFailed(id, 5);

      const rows = db.select().from(notificationQueue).all();
      expect(rows[0].status).toBe("failed");
      expect(rows[0].attempts).toBe(5);
    });

    it("keeps status as pending with retry for attempts below 5", () => {
      const id = store.enqueue("tenant-1", "low-balance", {});
      store.markFailed(id, 3);

      const rows = db.select().from(notificationQueue).all();
      expect(rows[0].status).toBe("pending");
    });
  });

  describe("listForTenant", () => {
    it("returns notifications for the given tenant", () => {
      store.enqueue("tenant-1", "low-balance", {});
      store.enqueue("tenant-2", "low-balance", {});
      store.enqueue("tenant-1", "welcome", {});

      const result = store.listForTenant("tenant-1");
      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("returns most recent first (ordered by createdAt desc)", () => {
      const id1 = store.enqueue("tenant-1", "template-a", {});
      const id2 = store.enqueue("tenant-1", "template-b", {});

      // Force distinct timestamps so ordering is deterministic
      db.update(notificationQueue).set({ createdAt: 1000 }).where(eq(notificationQueue.id, id1)).run();
      db.update(notificationQueue).set({ createdAt: 2000 }).where(eq(notificationQueue.id, id2)).run();

      const result = store.listForTenant("tenant-1");
      // Most recent (id2, createdAt=2000) should be first
      expect(result.entries[0].id).toBe(id2);
      expect(result.entries[1].id).toBe(id1);
    });

    it("paginates results", () => {
      store.enqueue("tenant-1", "template-a", {});
      store.enqueue("tenant-1", "template-b", {});
      store.enqueue("tenant-1", "template-c", {});

      const page1 = store.listForTenant("tenant-1", { limit: 2, offset: 0 });
      expect(page1.entries).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = store.listForTenant("tenant-1", { limit: 2, offset: 2 });
      expect(page2.entries).toHaveLength(1);
    });

    it("filters by status", () => {
      const id = store.enqueue("tenant-1", "low-balance", {});
      store.enqueue("tenant-1", "welcome", {});
      store.markSent(id);

      const sent = store.listForTenant("tenant-1", { status: "sent" });
      expect(sent.entries).toHaveLength(1);
      expect(sent.entries[0].status).toBe("sent");

      const pending = store.listForTenant("tenant-1", { status: "pending" });
      expect(pending.entries).toHaveLength(1);
    });

    it("returns empty for unknown tenant", () => {
      const result = store.listForTenant("nonexistent");
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });
});
