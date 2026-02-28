/**
 * Unit tests for DrizzleRateLimitRepository (WOP-927).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleRateLimitRepository } from "./drizzle-rate-limit-repository.js";

describe("DrizzleRateLimitRepository", () => {
  let repo: DrizzleRateLimitRepository;
  let db: DrizzleDb;
  let pool: PGlite;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    await truncateAllTables(pool);
    repo = new DrizzleRateLimitRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts count at 1 for the first request", async () => {
    const entry = await repo.increment("1.2.3.4", "api:default", 60_000);
    expect(entry.count).toBe(1);
    expect(entry.key).toBe("1.2.3.4");
    expect(entry.scope).toBe("api:default");
  });

  it("increments count on subsequent requests within the window", async () => {
    await repo.increment("1.2.3.4", "api:default", 60_000);
    await repo.increment("1.2.3.4", "api:default", 60_000);
    const entry = await repo.increment("1.2.3.4", "api:default", 60_000);
    expect(entry.count).toBe(3);
  });

  it("resets count when window expires", async () => {
    await repo.increment("1.2.3.4", "api:default", 60_000);
    await repo.increment("1.2.3.4", "api:default", 60_000);

    // Advance past the window
    vi.advanceTimersByTime(61_000);

    const entry = await repo.increment("1.2.3.4", "api:default", 60_000);
    expect(entry.count).toBe(1);
  });

  it("tracks different keys independently", async () => {
    await repo.increment("10.0.0.1", "api:default", 60_000);
    await repo.increment("10.0.0.1", "api:default", 60_000);
    const entry = await repo.increment("10.0.0.2", "api:default", 60_000);
    expect(entry.count).toBe(1);
  });

  it("tracks different scopes independently", async () => {
    await repo.increment("1.2.3.4", "api:default", 60_000);
    await repo.increment("1.2.3.4", "api:default", 60_000);
    const entry = await repo.increment("1.2.3.4", "api:webhook", 60_000);
    expect(entry.count).toBe(1);
  });

  it("get returns null for unknown entry", async () => {
    expect(await repo.get("1.2.3.4", "api:default")).toBeNull();
  });

  it("get returns current entry", async () => {
    await repo.increment("1.2.3.4", "api:default", 60_000);
    const entry = await repo.get("1.2.3.4", "api:default");
    expect(entry).not.toBeNull();
    expect(entry?.count).toBe(1);
  });

  it("purgeStale removes entries older than windowMs", async () => {
    await repo.increment("1.2.3.4", "api:default", 60_000);

    // Advance 2 minutes
    vi.advanceTimersByTime(2 * 60_000);
    await repo.increment("10.0.0.2", "api:default", 60_000);

    const removed = await repo.purgeStale(60_000);
    expect(removed).toBe(1);

    expect(await repo.get("1.2.3.4", "api:default")).toBeNull();
    expect(await repo.get("10.0.0.2", "api:default")).not.toBeNull();
  });
});
