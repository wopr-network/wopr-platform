/**
 * Unit tests for DrizzleProviderHealthRepository (WOP-927).
 */
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleProviderHealthRepository } from "./drizzle-provider-health-repository.js";

function makeRepo() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS provider_health_overrides (
      adapter TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL DEFAULT 1,
      marked_at INTEGER NOT NULL
    );
  `);
  return { sqlite, repo: new DrizzleProviderHealthRepository(drizzle(sqlite, { schema })) };
}

describe("DrizzleProviderHealthRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let repo: DrizzleProviderHealthRepository;

  beforeEach(() => {
    const r = makeRepo();
    sqlite = r.sqlite;
    repo = r.repo;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns null for unknown adapter", () => {
    expect(repo.get("unknown-adapter")).toBeNull();
  });

  it("markUnhealthy persists override and get returns it", () => {
    repo.markUnhealthy("elevenlabs");
    const result = repo.get("elevenlabs");
    expect(result).not.toBeNull();
    expect(result?.adapter).toBe("elevenlabs");
    expect(result?.healthy).toBe(false);
    expect(result?.markedAt).toBeGreaterThan(0);
  });

  it("markHealthy removes override", () => {
    repo.markUnhealthy("elevenlabs");
    repo.markHealthy("elevenlabs");
    expect(repo.get("elevenlabs")).toBeNull();
  });

  it("markHealthy is idempotent for unknown adapter", () => {
    expect(() => repo.markHealthy("no-such-adapter")).not.toThrow();
  });

  it("markUnhealthy is idempotent (upsert)", () => {
    repo.markUnhealthy("elevenlabs");
    const first = repo.get("elevenlabs");
    repo.markUnhealthy("elevenlabs");
    const second = repo.get("elevenlabs");
    expect(second?.healthy).toBe(false);
    expect(second!.markedAt).toBeGreaterThanOrEqual(first!.markedAt);
  });

  it("getAll returns all unhealthy overrides", () => {
    repo.markUnhealthy("elevenlabs");
    repo.markUnhealthy("openai-tts");
    const all = repo.getAll();
    expect(all).toHaveLength(2);
    const adapters = all.map((r) => r.adapter).sort();
    expect(adapters).toEqual(["elevenlabs", "openai-tts"]);
  });

  it("getAll returns empty array when no overrides", () => {
    expect(repo.getAll()).toHaveLength(0);
  });

  it("purgeExpired removes entries older than ttlMs", () => {
    repo.markUnhealthy("elevenlabs");
    // ttlMs = -1 → cutoff = Date.now() - (-1) = Date.now() + 1, which is in the future,
    // so the just-inserted row (markedAt ≈ now) is < cutoff and gets removed.
    const removed = repo.purgeExpired(-1);
    expect(removed).toBe(1);
    expect(repo.get("elevenlabs")).toBeNull();
  });

  it("purgeExpired keeps entries newer than ttlMs", () => {
    repo.markUnhealthy("elevenlabs");
    // Very large TTL — nothing should be pruned
    const removed = repo.purgeExpired(999_999_999);
    expect(removed).toBe(0);
    expect(repo.get("elevenlabs")).not.toBeNull();
  });

  it("purgeExpired returns count of removed entries", () => {
    repo.markUnhealthy("a");
    repo.markUnhealthy("b");
    repo.markUnhealthy("c");
    // ttlMs = -1 → cutoff is 1ms in the future, so all just-inserted rows are purged
    const removed = repo.purgeExpired(-1);
    expect(removed).toBe(3);
  });
});
