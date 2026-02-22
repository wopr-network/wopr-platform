/**
 * Unit tests for DrizzleFleetEventRepository (WOP-927).
 */
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleFleetEventRepository } from "./drizzle-fleet-event-repository.js";

function makeRepo() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS fleet_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      cleared_at INTEGER
    );
  `);
  return { sqlite, repo: new DrizzleFleetEventRepository(drizzle(sqlite, { schema })) };
}

describe("DrizzleFleetEventRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let repo: DrizzleFleetEventRepository;

  beforeEach(() => {
    const r = makeRepo();
    sqlite = r.sqlite;
    repo = r.repo;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("isFleetStopFired returns false initially", () => {
    expect(repo.isFleetStopFired()).toBe(false);
  });

  it("fireFleetStop sets fired = true", () => {
    repo.fireFleetStop();
    expect(repo.isFleetStopFired()).toBe(true);
  });

  it("clearFleetStop sets fired = false", () => {
    repo.fireFleetStop();
    repo.clearFleetStop();
    expect(repo.isFleetStopFired()).toBe(false);
  });

  it("fireFleetStop is idempotent", () => {
    repo.fireFleetStop();
    repo.fireFleetStop();
    expect(repo.isFleetStopFired()).toBe(true);
  });

  it("clearFleetStop is idempotent when not fired", () => {
    expect(() => repo.clearFleetStop()).not.toThrow();
    expect(repo.isFleetStopFired()).toBe(false);
  });
});
