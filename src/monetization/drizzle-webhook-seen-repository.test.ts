import type { PGlite } from "@electric-sql/pglite";
import { DrizzleWebhookSeenRepository } from "@wopr-network/platform-core/billing";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "@wopr-network/platform-core/test/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("DrizzleWebhookSeenRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleWebhookSeenRepository;

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
    repo = new DrizzleWebhookSeenRepository(db);
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
    expect(await repo.isDuplicate("evt_123", "crypto")).toBe(false);
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
