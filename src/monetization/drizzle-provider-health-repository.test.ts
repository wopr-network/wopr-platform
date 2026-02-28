/**
 * Unit tests for DrizzleProviderHealthRepository (WOP-927).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleProviderHealthRepository } from "./drizzle-provider-health-repository.js";

describe("DrizzleProviderHealthRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleProviderHealthRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleProviderHealthRepository(db);
  });

  it("returns null for unknown adapter", async () => {
    expect(await repo.get("unknown-adapter")).toBeNull();
  });

  it("markUnhealthy persists override and get returns it", async () => {
    await repo.markUnhealthy("elevenlabs");
    const result = await repo.get("elevenlabs");
    expect(result).not.toBeNull();
    expect(result?.adapter).toBe("elevenlabs");
    expect(result?.healthy).toBe(false);
    expect(result?.markedAt).toBeGreaterThan(0);
  });

  it("markHealthy removes override", async () => {
    await repo.markUnhealthy("elevenlabs");
    await repo.markHealthy("elevenlabs");
    expect(await repo.get("elevenlabs")).toBeNull();
  });

  it("markHealthy is idempotent for unknown adapter", async () => {
    await expect(repo.markHealthy("no-such-adapter")).resolves.not.toThrow();
  });

  it("markUnhealthy is idempotent (upsert)", async () => {
    await repo.markUnhealthy("elevenlabs");
    const first = await repo.get("elevenlabs");
    await repo.markUnhealthy("elevenlabs");
    const second = await repo.get("elevenlabs");
    expect(second?.healthy).toBe(false);
    expect(second?.markedAt).toBeGreaterThanOrEqual(first?.markedAt ?? 0);
  });

  it("getAll returns all unhealthy overrides", async () => {
    await repo.markUnhealthy("elevenlabs");
    await repo.markUnhealthy("openai-tts");
    const all = await repo.getAll();
    expect(all).toHaveLength(2);
    const adapters = all.map((r) => r.adapter).sort();
    expect(adapters).toEqual(["elevenlabs", "openai-tts"]);
  });

  it("getAll returns empty array when no overrides", async () => {
    expect(await repo.getAll()).toHaveLength(0);
  });

  it("purgeExpired removes entries older than ttlMs", async () => {
    await repo.markUnhealthy("elevenlabs");
    // ttlMs = -1 → cutoff = Date.now() - (-1) = Date.now() + 1, which is in the future,
    // so the just-inserted row (markedAt ≈ now) is < cutoff and gets removed.
    const removed = await repo.purgeExpired(-1);
    expect(removed).toBe(1);
    expect(await repo.get("elevenlabs")).toBeNull();
  });

  it("purgeExpired keeps entries newer than ttlMs", async () => {
    await repo.markUnhealthy("elevenlabs");
    // Very large TTL — nothing should be pruned
    const removed = await repo.purgeExpired(999_999_999);
    expect(removed).toBe(0);
    expect(await repo.get("elevenlabs")).not.toBeNull();
  });

  it("purgeExpired returns count of removed entries", async () => {
    await repo.markUnhealthy("a");
    await repo.markUnhealthy("b");
    await repo.markUnhealthy("c");
    // ttlMs = -1 → cutoff is 1ms in the future, so all just-inserted rows are purged
    const removed = await repo.purgeExpired(-1);
    expect(removed).toBe(3);
  });
});
