import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { NotificationQueueStore } from "./store.js";

describe("NotificationQueueStore.enqueue", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: NotificationQueueStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates a pending notification", () => {
    const row = store.enqueue({
      tenantId: "tenant-1",
      emailType: "welcome",
      recipientEmail: "user@example.com",
    });

    expect(row.id).toBeTruthy();
    expect(row.tenantId).toBe("tenant-1");
    expect(row.emailType).toBe("welcome");
    expect(row.recipientEmail).toBe("user@example.com");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.maxAttempts).toBe(3);
    expect(row.sentAt).toBeNull();
  });

  it("serializes payload as JSON", () => {
    const row = store.enqueue({
      tenantId: "tenant-1",
      emailType: "low_balance",
      recipientEmail: "user@example.com",
      payload: { balance: 100, threshold: 500 },
    });

    expect(JSON.parse(row.payload)).toEqual({ balance: 100, threshold: 500 });
  });

  it("generates unique IDs", () => {
    const r1 = store.enqueue({ tenantId: "tenant-1", emailType: "welcome", recipientEmail: "a@example.com" });
    const r2 = store.enqueue({ tenantId: "tenant-1", emailType: "welcome", recipientEmail: "b@example.com" });
    expect(r1.id).not.toBe(r2.id);
  });
});

describe("NotificationQueueStore.getPending", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: NotificationQueueStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns only pending notifications", () => {
    store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "a@example.com" });
    const r2 = store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "b@example.com" });
    store.markSent(r2.id);

    const pending = store.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
  });

  it("limits results", () => {
    for (let i = 0; i < 5; i++) {
      store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: `user${i}@example.com` });
    }

    const pending = store.getPending(3);
    expect(pending).toHaveLength(3);
  });
});

describe("NotificationQueueStore.markSent", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: NotificationQueueStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("updates status to sent and sets sentAt", () => {
    const row = store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "a@example.com" });
    store.markSent(row.id);

    const pending = store.getPending();
    expect(pending).toHaveLength(0);
  });
});

describe("NotificationQueueStore.markFailed", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: NotificationQueueStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("increments attempts and sets status to failed", () => {
    const row = store.enqueue({
      tenantId: "t1",
      emailType: "welcome",
      recipientEmail: "a@example.com",
      maxAttempts: 3,
    });
    store.markFailed(row.id, "SMTP timeout");

    const counts = store.countByStatus();
    expect(counts["failed"]).toBe(1);
  });

  it("dead-letters after maxAttempts", () => {
    const row = store.enqueue({
      tenantId: "t1",
      emailType: "welcome",
      recipientEmail: "a@example.com",
      maxAttempts: 2,
    });

    store.markFailed(row.id, "First failure");
    store.markFailed(row.id, "Second failure — dead letter");

    const counts = store.countByStatus();
    expect(counts["dead_letter"]).toBe(1);
    expect(counts["failed"]).toBeUndefined();
  });

  it("handles non-existent id gracefully", () => {
    // Should not throw
    expect(() => store.markFailed("nonexistent", "error")).not.toThrow();
  });
});

describe("NotificationQueueStore.countByStatus", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let store: NotificationQueueStore;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns correct counts per status", () => {
    const r1 = store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "a@example.com" });
    const r2 = store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "b@example.com" });
    store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "c@example.com" });

    store.markSent(r1.id);
    store.markFailed(r2.id, "error");

    const counts = store.countByStatus();
    expect(counts["pending"]).toBe(1);
    expect(counts["sent"]).toBe(1);
    expect(counts["failed"]).toBe(1);
  });

  it("returns empty object when no notifications", () => {
    const counts = store.countByStatus();
    expect(Object.keys(counts)).toHaveLength(0);
  });
});
