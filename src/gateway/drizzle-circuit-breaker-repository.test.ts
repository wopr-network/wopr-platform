/**
 * Unit tests for DrizzleCircuitBreakerRepository (WOP-927).
 */
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleCircuitBreakerRepository } from "./drizzle-circuit-breaker-repository.js";

function makeRepo() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS circuit_breaker_states (
      instance_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      tripped_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_circuit_window ON circuit_breaker_states(window_start);
  `);
  return { sqlite, repo: new DrizzleCircuitBreakerRepository(drizzle(sqlite, { schema })) };
}

describe("DrizzleCircuitBreakerRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let repo: DrizzleCircuitBreakerRepository;

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

  it("get returns null for unknown instance", () => {
    expect(repo.get("inst-unknown")).toBeNull();
  });

  it("incrementOrReset starts count at 1 for new instance", () => {
    const state = repo.incrementOrReset("inst-1", 10_000);
    expect(state.count).toBe(1);
    expect(state.trippedAt).toBeNull();
    expect(state.instanceId).toBe("inst-1");
  });

  it("incrementOrReset increments within window", () => {
    repo.incrementOrReset("inst-1", 10_000);
    repo.incrementOrReset("inst-1", 10_000);
    const state = repo.incrementOrReset("inst-1", 10_000);
    expect(state.count).toBe(3);
  });

  it("incrementOrReset resets when window expires", () => {
    repo.incrementOrReset("inst-1", 10_000);
    repo.incrementOrReset("inst-1", 10_000);

    vi.advanceTimersByTime(11_000);

    const state = repo.incrementOrReset("inst-1", 10_000);
    expect(state.count).toBe(1);
    expect(state.trippedAt).toBeNull();
  });

  it("trip sets trippedAt", () => {
    repo.incrementOrReset("inst-1", 10_000);
    repo.trip("inst-1");

    const state = repo.get("inst-1");
    expect(state).not.toBeNull();
    expect(state?.trippedAt).not.toBeNull();
    expect(state?.trippedAt).toBe(Date.now());
  });

  it("reset clears trippedAt and count", () => {
    repo.incrementOrReset("inst-1", 10_000);
    repo.trip("inst-1");
    repo.reset("inst-1");

    const state = repo.get("inst-1");
    expect(state).not.toBeNull();
    expect(state?.trippedAt).toBeNull();
    expect(state?.count).toBe(0);
  });

  it("different instances have independent state", () => {
    repo.incrementOrReset("inst-a", 10_000);
    repo.trip("inst-a");

    const stateB = repo.incrementOrReset("inst-b", 10_000);
    expect(stateB.trippedAt).toBeNull();
    expect(stateB.count).toBe(1);
  });

  it("getAll returns all instances", () => {
    repo.incrementOrReset("inst-a", 10_000);
    repo.incrementOrReset("inst-b", 10_000);
    repo.incrementOrReset("inst-c", 10_000);

    const all = repo.getAll();
    expect(all.length).toBe(3);
    expect(all.map((e) => e.instanceId).sort()).toEqual(["inst-a", "inst-b", "inst-c"]);
  });
});
