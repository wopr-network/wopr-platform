import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { NotificationQueueStore } from "./store.js";

describe("NotificationQueueStore.enqueue", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;

  let store: NotificationQueueStore;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    pool.close();
  });

  it("creates a pending notification", async () => {
    const row = await store.enqueue({
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

  it("serializes payload as JSON", async () => {
    const row = await store.enqueue({
      tenantId: "tenant-1",
      emailType: "low_balance",
      recipientEmail: "user@example.com",
      payload: { balance: 100, threshold: 500 },
    });

    expect(JSON.parse(row.payload)).toEqual({ balance: 100, threshold: 500 });
  });

  it("generates unique IDs", async () => {
    const r1 = await store.enqueue({ tenantId: "tenant-1", emailType: "welcome", recipientEmail: "a@example.com" });
    const r2 = await store.enqueue({ tenantId: "tenant-1", emailType: "welcome", recipientEmail: "b@example.com" });
    expect(r1.id).not.toBe(r2.id);
  });
});

describe("NotificationQueueStore.getPending", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;

  let store: NotificationQueueStore;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    pool.close();
  });

  it("returns only pending notifications", async () => {
    await store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "a@example.com" });
    const r2 = await store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "b@example.com" });
    await store.markSent(r2.id);

    const pending = await store.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
  });

  it("limits results", async () => {
    for (let i = 0; i < 5; i++) {
      await store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: `user${i}@example.com` });
    }

    const pending = await store.getPending(3);
    expect(pending).toHaveLength(3);
  });
});

describe("NotificationQueueStore.markSent", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;

  let store: NotificationQueueStore;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    pool.close();
  });

  it("updates status to sent and sets sentAt", async () => {
    const row = await store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "a@example.com" });
    await store.markSent(row.id);

    const pending = await store.getPending();
    expect(pending).toHaveLength(0);
  });
});

describe("NotificationQueueStore.markFailed", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;

  let store: NotificationQueueStore;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    pool.close();
  });

  it("increments attempts and sets status to failed", async () => {
    const row = await store.enqueue({
      tenantId: "t1",
      emailType: "welcome",
      recipientEmail: "a@example.com",
      maxAttempts: 3,
    });
    await store.markFailed(row.id, "SMTP timeout");

    const counts = await store.countByStatus();
    expect(counts.failed).toBe(1);
  });

  it("dead-letters after maxAttempts", async () => {
    const row = await store.enqueue({
      tenantId: "t1",
      emailType: "welcome",
      recipientEmail: "a@example.com",
      maxAttempts: 2,
    });

    await store.markFailed(row.id, "First failure");
    await store.markFailed(row.id, "Second failure — dead letter");

    const counts = await store.countByStatus();
    expect(counts.dead_letter).toBe(1);
    expect(counts.failed).toBeUndefined();
  });

  it("handles non-existent id gracefully", async () => {
    // Should not throw
    await expect(store.markFailed("nonexistent", "error")).resolves.not.toThrow();
  });
});

describe("NotificationQueueStore.countByStatus", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;

  let store: NotificationQueueStore;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    store = new NotificationQueueStore(db);
  });

  afterEach(() => {
    pool.close();
  });

  it("returns correct counts per status", async () => {
    const r1 = await store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "a@example.com" });
    const r2 = await store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "b@example.com" });
    await store.enqueue({ tenantId: "t1", emailType: "welcome", recipientEmail: "c@example.com" });

    await store.markSent(r1.id);
    await store.markFailed(r2.id, "error");

    const counts = await store.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.sent).toBe(1);
    expect(counts.failed).toBe(1);
  });

  it("returns empty object when no notifications", async () => {
    const counts = await store.countByStatus();
    expect(Object.keys(counts)).toHaveLength(0);
  });
});
