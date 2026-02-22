/**
 * Unit tests for DrizzleRateLimitRepository (WOP-927).
 */
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleRateLimitRepository } from "./drizzle-rate-limit-repository.js";

function makeRepo() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_entries (
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      PRIMARY KEY (key, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_entries(window_start);
  `);
  return { sqlite, repo: new DrizzleRateLimitRepository(drizzle(sqlite, { schema })) };
}

describe("DrizzleRateLimitRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let repo: DrizzleRateLimitRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    const r = makeRepo();
    sqlite = r.sqlite;
    repo = r.repo;
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it("starts count at 1 for the first request", () => {
    const entry = repo.increment("1.2.3.4", "api:default", 60_000);
    expect(entry.count).toBe(1);
    expect(entry.key).toBe("1.2.3.4");
    expect(entry.scope).toBe("api:default");
  });

  it("increments count on subsequent requests within the window", () => {
    repo.increment("1.2.3.4", "api:default", 60_000);
    repo.increment("1.2.3.4", "api:default", 60_000);
    const entry = repo.increment("1.2.3.4", "api:default", 60_000);
    expect(entry.count).toBe(3);
  });

  it("resets count when window expires", () => {
    repo.increment("1.2.3.4", "api:default", 60_000);
    repo.increment("1.2.3.4", "api:default", 60_000);

    // Advance past the window
    vi.advanceTimersByTime(61_000);

    const entry = repo.increment("1.2.3.4", "api:default", 60_000);
    expect(entry.count).toBe(1);
  });

  it("tracks different keys independently", () => {
    repo.increment("10.0.0.1", "api:default", 60_000);
    repo.increment("10.0.0.1", "api:default", 60_000);
    const entry = repo.increment("10.0.0.2", "api:default", 60_000);
    expect(entry.count).toBe(1);
  });

  it("tracks different scopes independently", () => {
    repo.increment("1.2.3.4", "api:default", 60_000);
    repo.increment("1.2.3.4", "api:default", 60_000);
    const entry = repo.increment("1.2.3.4", "api:webhook", 60_000);
    expect(entry.count).toBe(1);
  });

  it("get returns null for unknown entry", () => {
    expect(repo.get("1.2.3.4", "api:default")).toBeNull();
  });

  it("get returns current entry", () => {
    repo.increment("1.2.3.4", "api:default", 60_000);
    const entry = repo.get("1.2.3.4", "api:default");
    expect(entry).not.toBeNull();
    expect(entry?.count).toBe(1);
  });

  it("purgeStale removes entries older than windowMs", () => {
    repo.increment("1.2.3.4", "api:default", 60_000);

    // Advance 2 minutes
    vi.advanceTimersByTime(2 * 60_000);
    repo.increment("10.0.0.2", "api:default", 60_000);

    const removed = repo.purgeStale(60_000);
    expect(removed).toBe(1);

    expect(repo.get("1.2.3.4", "api:default")).toBeNull();
    expect(repo.get("10.0.0.2", "api:default")).not.toBeNull();
  });
});
