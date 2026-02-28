import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleBotBilling } from "./bot-billing.js";

describe("bot-billing storage tier", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let billing: DrizzleBotBilling;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    billing = new DrizzleBotBilling(db);
  });

  it("new bot defaults to standard storage tier", async () => {
    await billing.registerBot("bot-1", "tenant-1", "TestBot");
    expect(await billing.getStorageTier("bot-1")).toBe("standard");
  });

  it("setStorageTier updates tier", async () => {
    await billing.registerBot("bot-1", "tenant-1", "TestBot");
    await billing.setStorageTier("bot-1", "pro");
    expect(await billing.getStorageTier("bot-1")).toBe("pro");
  });

  it("getStorageTier returns null for unknown bot", async () => {
    expect(await billing.getStorageTier("nonexistent")).toBeNull();
  });

  it("getStorageTierCostsForTenant sums active bot storage costs", async () => {
    await billing.registerBot("bot-1", "tenant-1", "Bot1");
    await billing.registerBot("bot-2", "tenant-1", "Bot2");
    await billing.registerBot("bot-3", "tenant-1", "Bot3");
    await billing.setStorageTier("bot-1", "plus"); // 3 credits/day
    await billing.setStorageTier("bot-2", "max"); // 15 credits/day
    // bot-3 stays standard                        // 0 credits/day
    expect((await billing.getStorageTierCostsForTenant("tenant-1")).toCents()).toBe(18);
  });

  it("getStorageTierCostsForTenant excludes suspended bots", async () => {
    await billing.registerBot("bot-1", "tenant-1", "Bot1");
    await billing.setStorageTier("bot-1", "pro"); // 8 credits/day
    await billing.suspendBot("bot-1");
    expect((await billing.getStorageTierCostsForTenant("tenant-1")).toCents()).toBe(0);
  });

  it("getStorageTierCostsForTenant returns 0 for unknown tenant", async () => {
    expect((await billing.getStorageTierCostsForTenant("nonexistent")).toCents()).toBe(0);
  });
});
