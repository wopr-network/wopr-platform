import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleSigPenaltyRepository } from "./drizzle-sig-penalty-repository.js";

describe("DrizzleSigPenaltyRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleSigPenaltyRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleSigPenaltyRepository(db);
  });

  it("returns null for unknown IP", async () => {
    expect(await repo.get("1.2.3.4", "stripe")).toBeNull();
  });

  it("records and retrieves a penalty", async () => {
    await repo.recordFailure("1.2.3.4", "stripe");
    const penalty = await repo.get("1.2.3.4", "stripe");
    expect(penalty).not.toBeNull();
    expect(penalty?.failures).toBe(1);
    expect(penalty?.blockedUntil).toBeGreaterThan(Date.now());
  });

  it("increments failures on repeated calls", async () => {
    await repo.recordFailure("1.2.3.4", "stripe");
    await repo.recordFailure("1.2.3.4", "stripe");
    const penalty = await repo.get("1.2.3.4", "stripe");
    expect(penalty?.failures).toBe(2);
  });

  it("clears penalty on clear()", async () => {
    await repo.recordFailure("1.2.3.4", "stripe");
    await repo.clear("1.2.3.4", "stripe");
    expect(await repo.get("1.2.3.4", "stripe")).toBeNull();
  });

  it("does not affect other IP/source combinations", async () => {
    await repo.recordFailure("1.2.3.4", "stripe");
    await repo.recordFailure("5.6.7.8", "twilio");
    expect((await repo.get("1.2.3.4", "stripe"))?.failures).toBe(1);
    expect((await repo.get("5.6.7.8", "twilio"))?.failures).toBe(1);
    expect(await repo.get("1.2.3.4", "twilio")).toBeNull();
  });

  it("purges stale entries", async () => {
    await repo.recordFailure("1.2.3.4", "stripe");
    // purgeStale with a very large decay: cutoff = now - decayMs is far in the past,
    // but blockedUntil is in the future, so entry is NOT stale yet
    expect(await repo.purgeStale(0)).toBe(0);
    // Use negative decay to push cutoff into the far future (now - (-largeMs) = now + largeMs)
    // so blockedUntil < cutoff and the entry is pruned
    const purged = await repo.purgeStale(-24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    expect(await repo.get("1.2.3.4", "stripe")).toBeNull();
  });
});
