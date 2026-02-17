import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { nodes } from "../db/schema/index.js";
import { findPlacement, findPlacementExcluding } from "./placement.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      capacity_mb INTEGER NOT NULL,
      used_mb INTEGER NOT NULL DEFAULT 0,
      agent_version TEXT,
      last_heartbeat_at INTEGER,
      registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  return { db, sqlite };
}

describe("findPlacement", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns the node with most free capacity", () => {
    // node-1: 1000 - 800 = 200 free
    // node-2: 2000 - 500 = 1500 free (winner)
    // node-3: 1000 - 950 = 50 free (not enough)
    db.insert(nodes)
      .values([
        { id: "node-1", host: "10.0.0.1", capacityMb: 1000, usedMb: 800, status: "active", registeredAt: 1 },
        { id: "node-2", host: "10.0.0.2", capacityMb: 2000, usedMb: 500, status: "active", registeredAt: 1 },
        { id: "node-3", host: "10.0.0.3", capacityMb: 1000, usedMb: 950, status: "active", registeredAt: 1 },
      ])
      .run();

    const result = findPlacement(db, 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
    expect(result?.availableMb).toBe(1500);
  });

  it("returns the host for the winning node", () => {
    db.insert(nodes)
      .values([{ id: "node-1", host: "10.0.0.1", capacityMb: 1000, usedMb: 0, status: "active", registeredAt: 1 }])
      .run();

    const result = findPlacement(db, 100);
    expect(result).not.toBeNull();
    expect(result?.host).toBe("10.0.0.1");
  });

  it("returns null when no node has capacity", () => {
    db.insert(nodes)
      .values([{ id: "node-1", host: "10.0.0.1", capacityMb: 1000, usedMb: 950, status: "active", registeredAt: 1 }])
      .run();

    const result = findPlacement(db, 100);
    expect(result).toBeNull();
  });

  it("returns null when nodes table is empty", () => {
    const result = findPlacement(db, 100);
    expect(result).toBeNull();
  });

  it("skips non-active draining nodes", () => {
    db.insert(nodes)
      .values([
        { id: "node-1", host: "10.0.0.1", capacityMb: 2000, usedMb: 0, status: "draining", registeredAt: 1 },
        { id: "node-2", host: "10.0.0.2", capacityMb: 1000, usedMb: 0, status: "active", registeredAt: 1 },
      ])
      .run();

    const result = findPlacement(db, 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });

  it("skips offline nodes", () => {
    db.insert(nodes)
      .values([
        { id: "node-1", host: "10.0.0.1", capacityMb: 2000, usedMb: 0, status: "offline", registeredAt: 1 },
        { id: "node-2", host: "10.0.0.2", capacityMb: 2000, usedMb: 0, status: "unhealthy", registeredAt: 1 },
        { id: "node-3", host: "10.0.0.3", capacityMb: 2000, usedMb: 0, status: "recovering", registeredAt: 1 },
      ])
      .run();

    const result = findPlacement(db, 100);
    expect(result).toBeNull();
  });

  it("uses 100 MB as default requiredMb", () => {
    // node with exactly 100 MB free should match
    db.insert(nodes)
      .values([{ id: "node-1", host: "10.0.0.1", capacityMb: 1000, usedMb: 900, status: "active", registeredAt: 1 }])
      .run();

    const result = findPlacement(db);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-1");
    expect(result?.availableMb).toBe(100);
  });

  it("returns null when free capacity is exactly below required", () => {
    db.insert(nodes)
      .values([{ id: "node-1", host: "10.0.0.1", capacityMb: 1000, usedMb: 901, status: "active", registeredAt: 1 }])
      .run();

    const result = findPlacement(db);
    expect(result).toBeNull();
  });
});

describe("findPlacementExcluding", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it("excludes specified node IDs", () => {
    db.insert(nodes)
      .values([
        { id: "node-1", host: "10.0.0.1", capacityMb: 2000, usedMb: 0, status: "active", registeredAt: 1 },
        { id: "node-2", host: "10.0.0.2", capacityMb: 1000, usedMb: 0, status: "active", registeredAt: 1 },
      ])
      .run();

    const result = findPlacementExcluding(db, ["node-1"], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });

  it("returns null when all nodes excluded", () => {
    db.insert(nodes)
      .values([{ id: "node-1", host: "10.0.0.1", capacityMb: 2000, usedMb: 0, status: "active", registeredAt: 1 }])
      .run();

    const result = findPlacementExcluding(db, ["node-1"], 100);
    expect(result).toBeNull();
  });

  it("excludes multiple node IDs", () => {
    db.insert(nodes)
      .values([
        { id: "node-1", host: "10.0.0.1", capacityMb: 2000, usedMb: 0, status: "active", registeredAt: 1 },
        { id: "node-2", host: "10.0.0.2", capacityMb: 1500, usedMb: 0, status: "active", registeredAt: 1 },
        { id: "node-3", host: "10.0.0.3", capacityMb: 1000, usedMb: 0, status: "active", registeredAt: 1 },
      ])
      .run();

    const result = findPlacementExcluding(db, ["node-1", "node-2"], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-3");
  });

  it("delegates to findPlacement when excludeNodeIds is empty", () => {
    db.insert(nodes)
      .values([{ id: "node-1", host: "10.0.0.1", capacityMb: 2000, usedMb: 0, status: "active", registeredAt: 1 }])
      .run();

    const result = findPlacementExcluding(db, [], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-1");
  });

  it("still picks most free capacity among non-excluded nodes", () => {
    db.insert(nodes)
      .values([
        { id: "node-1", host: "10.0.0.1", capacityMb: 2000, usedMb: 0, status: "active", registeredAt: 1 },
        { id: "node-2", host: "10.0.0.2", capacityMb: 1500, usedMb: 0, status: "active", registeredAt: 1 },
        { id: "node-3", host: "10.0.0.3", capacityMb: 800, usedMb: 0, status: "active", registeredAt: 1 },
      ])
      .run();

    // Exclude node-1 (most capacity), node-2 should win
    const result = findPlacementExcluding(db, ["node-1"], 100);
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("node-2");
  });
});
