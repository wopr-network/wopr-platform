import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test/db.js";
import { DrizzleBotBilling } from "./bot-billing.js";

describe("bot-billing storage tier", () => {
  let pool: PGlite;
  let billing: DrizzleBotBilling;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    billing = new DrizzleBotBilling(db);
  });

  afterEach(async () => {
    await pool.close();
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
    expect(await billing.getStorageTierCostsForTenant("tenant-1")).toBe(18);
  });

  it("getStorageTierCostsForTenant excludes suspended bots", async () => {
    await billing.registerBot("bot-1", "tenant-1", "Bot1");
    await billing.setStorageTier("bot-1", "pro"); // 8 credits/day
    await billing.suspendBot("bot-1");
    expect(await billing.getStorageTierCostsForTenant("tenant-1")).toBe(0);
  });

  it("getStorageTierCostsForTenant returns 0 for unknown tenant", async () => {
    expect(await billing.getStorageTierCostsForTenant("nonexistent")).toBe(0);
  });
});
