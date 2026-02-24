import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { DrizzleBotBilling } from "./bot-billing.js";

function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      node_id TEXT,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      storage_tier TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

describe("bot-billing storage tier", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let billing: DrizzleBotBilling;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    billing = new DrizzleBotBilling(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("new bot defaults to standard storage tier", () => {
    billing.registerBot("bot-1", "tenant-1", "TestBot");
    expect(billing.getStorageTier("bot-1")).toBe("standard");
  });

  it("setStorageTier updates tier", () => {
    billing.registerBot("bot-1", "tenant-1", "TestBot");
    billing.setStorageTier("bot-1", "pro");
    expect(billing.getStorageTier("bot-1")).toBe("pro");
  });

  it("getStorageTier returns null for unknown bot", () => {
    expect(billing.getStorageTier("nonexistent")).toBeNull();
  });

  it("getStorageTierCostsForTenant sums active bot storage costs", () => {
    billing.registerBot("bot-1", "tenant-1", "Bot1");
    billing.registerBot("bot-2", "tenant-1", "Bot2");
    billing.registerBot("bot-3", "tenant-1", "Bot3");
    billing.setStorageTier("bot-1", "plus"); // 3 credits/day
    billing.setStorageTier("bot-2", "max"); // 15 credits/day
    // bot-3 stays standard                  // 0 credits/day
    expect(billing.getStorageTierCostsForTenant("tenant-1")).toBe(18);
  });

  it("getStorageTierCostsForTenant excludes suspended bots", () => {
    billing.registerBot("bot-1", "tenant-1", "Bot1");
    billing.setStorageTier("bot-1", "pro"); // 8 credits/day
    billing.suspendBot("bot-1");
    expect(billing.getStorageTierCostsForTenant("tenant-1")).toBe(0);
  });

  it("getStorageTierCostsForTenant returns 0 for unknown tenant", () => {
    expect(billing.getStorageTierCostsForTenant("nonexistent")).toBe(0);
  });
});
