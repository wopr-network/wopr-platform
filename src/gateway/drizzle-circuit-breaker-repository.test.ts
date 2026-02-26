/**
 * Unit tests for DrizzleCircuitBreakerRepository (WOP-927).
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleCircuitBreakerRepository } from "./drizzle-circuit-breaker-repository.js";

describe("DrizzleCircuitBreakerRepository", () => {
  let repo: DrizzleCircuitBreakerRepository;
  let db: DrizzleDb;
  let pool: PGlite;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));
    ({ db, pool } = await createTestDb());
    repo = new DrizzleCircuitBreakerRepository(db);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool.close();
  });

  it("get returns null for unknown instance", async () => {
    expect(await repo.get("inst-unknown")).toBeNull();
  });

  it("incrementOrReset starts count at 1 for new instance", async () => {
    const state = await repo.incrementOrReset("inst-1", 10_000);
    expect(state.count).toBe(1);
    expect(state.trippedAt).toBeNull();
    expect(state.instanceId).toBe("inst-1");
  });

  it("incrementOrReset increments within window", async () => {
    await repo.incrementOrReset("inst-1", 10_000);
    await repo.incrementOrReset("inst-1", 10_000);
    const state = await repo.incrementOrReset("inst-1", 10_000);
    expect(state.count).toBe(3);
  });

  it("incrementOrReset resets when window expires", async () => {
    await repo.incrementOrReset("inst-1", 10_000);
    await repo.incrementOrReset("inst-1", 10_000);

    vi.advanceTimersByTime(11_000);

    const state = await repo.incrementOrReset("inst-1", 10_000);
    expect(state.count).toBe(1);
    expect(state.trippedAt).toBeNull();
  });

  it("trip sets trippedAt", async () => {
    await repo.incrementOrReset("inst-1", 10_000);
    await repo.trip("inst-1");

    const state = await repo.get("inst-1");
    expect(state).not.toBeNull();
    expect(state?.trippedAt).not.toBeNull();
    expect(state?.trippedAt).toBe(Date.now());
  });

  it("reset clears trippedAt and count", async () => {
    await repo.incrementOrReset("inst-1", 10_000);
    await repo.trip("inst-1");
    await repo.reset("inst-1");

    const state = await repo.get("inst-1");
    expect(state).not.toBeNull();
    expect(state?.trippedAt).toBeNull();
    expect(state?.count).toBe(0);
  });

  it("different instances have independent state", async () => {
    await repo.incrementOrReset("inst-a", 10_000);
    await repo.trip("inst-a");

    const stateB = await repo.incrementOrReset("inst-b", 10_000);
    expect(stateB.trippedAt).toBeNull();
    expect(stateB.count).toBe(1);
  });

  it("getAll returns all instances", async () => {
    await repo.incrementOrReset("inst-a", 10_000);
    await repo.incrementOrReset("inst-b", 10_000);
    await repo.incrementOrReset("inst-c", 10_000);

    const all = await repo.getAll();
    expect(all.length).toBe(3);
    expect(all.map((e) => e.instanceId).sort()).toEqual(["inst-a", "inst-b", "inst-c"]);
  });
});
