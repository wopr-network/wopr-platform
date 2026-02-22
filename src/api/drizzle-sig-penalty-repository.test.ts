import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleSigPenaltyRepository } from "./drizzle-sig-penalty-repository.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS webhook_sig_penalties (
      ip TEXT NOT NULL,
      source TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ip, source)
    );
    CREATE INDEX IF NOT EXISTS idx_sig_penalties_blocked ON webhook_sig_penalties (blocked_until);
  `);
  return drizzle(sqlite, { schema });
}

describe("DrizzleSigPenaltyRepository", () => {
  let repo: DrizzleSigPenaltyRepository;

  beforeEach(() => {
    repo = new DrizzleSigPenaltyRepository(makeDb());
  });

  it("returns null for unknown IP", () => {
    expect(repo.get("1.2.3.4", "stripe")).toBeNull();
  });

  it("records and retrieves a penalty", () => {
    repo.recordFailure("1.2.3.4", "stripe");
    const penalty = repo.get("1.2.3.4", "stripe");
    expect(penalty).not.toBeNull();
    expect(penalty?.failures).toBe(1);
    expect(penalty?.blockedUntil).toBeGreaterThan(Date.now());
  });

  it("increments failures on repeated calls", () => {
    repo.recordFailure("1.2.3.4", "stripe");
    repo.recordFailure("1.2.3.4", "stripe");
    const penalty = repo.get("1.2.3.4", "stripe");
    expect(penalty?.failures).toBe(2);
  });

  it("clears penalty on clear()", () => {
    repo.recordFailure("1.2.3.4", "stripe");
    repo.clear("1.2.3.4", "stripe");
    expect(repo.get("1.2.3.4", "stripe")).toBeNull();
  });

  it("does not affect other IP/source combinations", () => {
    repo.recordFailure("1.2.3.4", "stripe");
    repo.recordFailure("5.6.7.8", "twilio");
    expect(repo.get("1.2.3.4", "stripe")?.failures).toBe(1);
    expect(repo.get("5.6.7.8", "twilio")?.failures).toBe(1);
    expect(repo.get("1.2.3.4", "twilio")).toBeNull();
  });

  it("purges stale entries", () => {
    repo.recordFailure("1.2.3.4", "stripe");
    // purgeStale with a very large decay: cutoff = now - decayMs is far in the past,
    // but blockedUntil is in the future, so entry is NOT stale yet
    expect(repo.purgeStale(0)).toBe(0);
    // Use negative decay to push cutoff into the far future (now - (-largeMs) = now + largeMs)
    // so blockedUntil < cutoff and the entry is pruned
    const purged = repo.purgeStale(-24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    expect(repo.get("1.2.3.4", "stripe")).toBeNull();
  });
});
