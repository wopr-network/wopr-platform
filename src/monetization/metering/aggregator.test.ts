import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents, usageSummaries } from "../../db/schema/meter-events.js";
import { createTestDb } from "../../test/db.js";
import { Credit } from "../credit.js";
import { DrizzleMeterAggregator } from "./aggregator.js";

const WINDOW_MS = 60_000; // 1-minute windows

describe("DrizzleMeterAggregator edge cases", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let aggregator: DrizzleMeterAggregator;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    pool = testDb.pool;
    aggregator = new DrizzleMeterAggregator(db, { windowMs: WINDOW_MS });
  });

  afterEach(async () => {
    aggregator.stop();
    await pool.close();
  });

  async function insertEvent(overrides: {
    tenant?: string;
    cost?: number;
    charge?: number;
    capability?: string;
    provider?: string;
    timestamp: number;
    id?: string;
  }) {
    await db.insert(meterEvents).values({
      id: overrides.id ?? crypto.randomUUID(),
      tenant: overrides.tenant ?? "tenant-1",
      cost: overrides.cost ?? Credit.fromDollars(0.001).toRaw(),
      charge: overrides.charge ?? Credit.fromDollars(0.002).toRaw(),
      capability: overrides.capability ?? "embeddings",
      provider: overrides.provider ?? "openai",
      timestamp: overrides.timestamp,
    });
  }

  it("sums events correctly within a single completed window", async () => {
    const baseTime = 0;
    await insertEvent({ timestamp: baseTime + 10_000, cost: 1_000_000, charge: 2_000_000 });
    await insertEvent({ timestamp: baseTime + 20_000, cost: 3_000_000, charge: 4_000_000 });
    await insertEvent({ timestamp: baseTime + 30_000, cost: 5_000_000, charge: 6_000_000 });

    const inserted = await aggregator.aggregate(WINDOW_MS + 1);

    expect(inserted).toBe(1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    expect(real).toHaveLength(1);
    expect(real[0].tenant).toBe("tenant-1");
    expect(real[0].eventCount).toBe(3);
    expect(real[0].totalCost).toBe(9_000_000);
    expect(real[0].totalCharge).toBe(12_000_000);
    expect(real[0].windowStart).toBe(0);
    expect(real[0].windowEnd).toBe(WINDOW_MS);
  });

  it("returns zero and inserts sentinel when no events exist", async () => {
    const inserted = await aggregator.aggregate(WINDOW_MS + 1);

    expect(inserted).toBe(0);

    const summaries = await db.select().from(usageSummaries);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].tenant).toBe("__sentinel__");
    expect(summaries[0].eventCount).toBe(0);
  });

  it("rejects duplicate event IDs via primary key constraint", async () => {
    const eventId = crypto.randomUUID();
    await insertEvent({ timestamp: 10_000, id: eventId });

    await expect(insertEvent({ timestamp: 10_000, id: eventId })).rejects.toThrow();

    const inserted = await aggregator.aggregate(WINDOW_MS + 1);
    expect(inserted).toBe(1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    expect(real).toHaveLength(1);
    expect(real[0].eventCount).toBe(1);
  });

  it("handles very large cost totals without overflow", async () => {
    const largeCost = 1_000_000_000_000;
    const largeCharge = 2_000_000_000_000;

    for (let i = 0; i < 5; i++) {
      await insertEvent({ timestamp: 10_000 + i * 1000, cost: largeCost, charge: largeCharge });
    }

    const inserted = await aggregator.aggregate(WINDOW_MS + 1);
    expect(inserted).toBe(1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    expect(real).toHaveLength(1);
    expect(real[0].totalCost).toBe(5_000_000_000_000);
    expect(real[0].totalCharge).toBe(10_000_000_000_000);
    expect(real[0].eventCount).toBe(5);
  });

  it("isolates aggregation per tenant", async () => {
    await insertEvent({ tenant: "tenant-A", timestamp: 10_000, cost: 1_000_000, charge: 2_000_000 });
    await insertEvent({ tenant: "tenant-A", timestamp: 20_000, cost: 3_000_000, charge: 4_000_000 });
    await insertEvent({ tenant: "tenant-B", timestamp: 15_000, cost: 5_000_000, charge: 6_000_000 });

    const inserted = await aggregator.aggregate(WINDOW_MS + 1);
    expect(inserted).toBe(2);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    expect(real).toHaveLength(2);

    const tenantA = real.find((s) => s.tenant === "tenant-A");
    expect(tenantA).toEqual(
      expect.objectContaining({
        tenant: "tenant-A",
        eventCount: 2,
        totalCost: 4_000_000,
        totalCharge: 6_000_000,
      }),
    );
    const tenantB = real.find((s) => s.tenant === "tenant-B");
    expect(tenantB).toEqual(
      expect.objectContaining({
        tenant: "tenant-B",
        eventCount: 1,
        totalCost: 5_000_000,
        totalCharge: 6_000_000,
      }),
    );
  });

  it("includes events at window start, excludes events at window end", async () => {
    await insertEvent({ timestamp: 0, cost: 1_000_000, charge: 1_000_000 });
    await insertEvent({ timestamp: 59_999, cost: 2_000_000, charge: 2_000_000 });
    await insertEvent({ timestamp: 60_000, cost: 100_000_000, charge: 100_000_000 });

    const inserted = await aggregator.aggregate(2 * WINDOW_MS + 1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");

    const window0 = real.find((s) => s.windowStart === 0);
    expect(window0).toEqual(
      expect.objectContaining({
        windowStart: 0,
        eventCount: 2,
        totalCost: 3_000_000,
      }),
    );

    const window1 = real.find((s) => s.windowStart === 60_000);
    expect(window1).toEqual(
      expect.objectContaining({
        windowStart: 60_000,
        eventCount: 1,
        totalCost: 100_000_000,
      }),
    );

    // window0: 1 tenant/capability/provider group = 1 row
    // window1: 1 tenant/capability/provider group = 1 row
    expect(inserted).toBe(2);
  });

  it("aggregates zero-cost events correctly", async () => {
    await insertEvent({ timestamp: 10_000, cost: 0, charge: 0 });
    await insertEvent({ timestamp: 20_000, cost: 0, charge: 0 });

    const inserted = await aggregator.aggregate(WINDOW_MS + 1);
    expect(inserted).toBe(1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    expect(real).toHaveLength(1);
    expect(real[0].totalCost).toBe(0);
    expect(real[0].totalCharge).toBe(0);
    expect(real[0].eventCount).toBe(2);
  });

  it("handles a single event exactly at window boundary", async () => {
    // Event at timestamp 0 (window start) — should be in window [0, WINDOW_MS)
    await insertEvent({ timestamp: 0, cost: 1_000_000, charge: 2_000_000 });

    const inserted = await aggregator.aggregate(WINDOW_MS + 1);
    expect(inserted).toBe(1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    expect(real).toHaveLength(1);
    expect(real[0].eventCount).toBe(1);
    expect(real[0].totalCost).toBe(1_000_000);
  });

  it("handles event one unit before window end", async () => {
    // Event at WINDOW_MS - 1 should be included in first window
    await insertEvent({ timestamp: WINDOW_MS - 1, cost: 500_000, charge: 600_000 });

    const inserted = await aggregator.aggregate(WINDOW_MS + 1);
    expect(inserted).toBe(1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    expect(real).toHaveLength(1);
    expect(real[0].windowStart).toBe(0);
    expect(real[0].eventCount).toBe(1);
    expect(real[0].totalCost).toBe(500_000);
  });

  it("handles event exactly at window end (goes to next window)", async () => {
    // Event at exactly WINDOW_MS should be in window [WINDOW_MS, 2*WINDOW_MS)
    await insertEvent({ timestamp: WINDOW_MS, cost: 700_000, charge: 800_000 });

    await aggregator.aggregate(2 * WINDOW_MS + 1);

    const summaries = await db.select().from(usageSummaries);
    const real = summaries.filter((s) => s.tenant !== "__sentinel__");
    // Should be in second window, not first
    expect(real).toHaveLength(1);
    expect(real[0].windowStart).toBe(WINDOW_MS);
    expect(real[0].eventCount).toBe(1);
    expect(real[0].totalCost).toBe(700_000);
  });
});
