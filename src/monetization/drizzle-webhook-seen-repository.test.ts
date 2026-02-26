import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { DrizzleWebhookSeenRepository } from "./drizzle-webhook-seen-repository.js";

describe("DrizzleWebhookSeenRepository", () => {
  let pool: PGlite;
  let repo: DrizzleWebhookSeenRepository;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    repo = new DrizzleWebhookSeenRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("returns false for unknown event", async () => {
    expect(await repo.isDuplicate("evt_unknown", "stripe")).toBe(false);
  });

  it("marks and detects duplicate", async () => {
    await repo.markSeen("evt_123", "stripe");
    expect(await repo.isDuplicate("evt_123", "stripe")).toBe(true);
  });

  it("isolates by source", async () => {
    await repo.markSeen("evt_123", "stripe");
    expect(await repo.isDuplicate("evt_123", "payram")).toBe(false);
  });

  it("onConflictDoNothing — markSeen twice is idempotent", async () => {
    await repo.markSeen("evt_abc", "stripe");
    await expect(repo.markSeen("evt_abc", "stripe")).resolves.not.toThrow();
    expect(await repo.isDuplicate("evt_abc", "stripe")).toBe(true);
  });

  it("purgeExpired removes old entries", async () => {
    await repo.markSeen("evt_old", "stripe");
    // Use negative TTL to push cutoff into the future so entry is considered expired
    const purged = await repo.purgeExpired(-24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    expect(await repo.isDuplicate("evt_old", "stripe")).toBe(false);
  });

  it("purgeExpired leaves fresh entries", async () => {
    await repo.markSeen("evt_fresh", "stripe");
    const purged = await repo.purgeExpired(24 * 60 * 60 * 1000);
    expect(purged).toBe(0);
    expect(await repo.isDuplicate("evt_fresh", "stripe")).toBe(true);
  });
});
