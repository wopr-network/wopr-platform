import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleWebhookSeenRepository } from "./drizzle-webhook-seen-repository.js";

function makeRepo() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE webhook_seen_events (
      event_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      seen_at INTEGER NOT NULL
    )
  `);
  const db = drizzle(sqlite, { schema });
  return new DrizzleWebhookSeenRepository(db);
}

describe("DrizzleWebhookSeenRepository", () => {
  let repo: DrizzleWebhookSeenRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  it("returns false for unknown event", () => {
    expect(repo.isDuplicate("evt_unknown", "stripe")).toBe(false);
  });

  it("marks and detects duplicate", () => {
    repo.markSeen("evt_123", "stripe");
    expect(repo.isDuplicate("evt_123", "stripe")).toBe(true);
  });

  it("isolates by source", () => {
    repo.markSeen("evt_123", "stripe");
    expect(repo.isDuplicate("evt_123", "payram")).toBe(false);
  });

  it("onConflictDoNothing — markSeen twice is idempotent", () => {
    repo.markSeen("evt_abc", "stripe");
    expect(() => repo.markSeen("evt_abc", "stripe")).not.toThrow();
    expect(repo.isDuplicate("evt_abc", "stripe")).toBe(true);
  });

  it("purgeExpired removes old entries", () => {
    repo.markSeen("evt_old", "stripe");
    // Use negative TTL to push cutoff into the future so entry is considered expired
    const purged = repo.purgeExpired(-24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    expect(repo.isDuplicate("evt_old", "stripe")).toBe(false);
  });

  it("purgeExpired leaves fresh entries", () => {
    repo.markSeen("evt_fresh", "stripe");
    const purged = repo.purgeExpired(24 * 60 * 60 * 1000);
    expect(purged).toBe(0);
    expect(repo.isDuplicate("evt_fresh", "stripe")).toBe(true);
  });
});
