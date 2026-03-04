import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleUsageSummaryRepository, type UsageSummaryInsert } from "./drizzle-usage-summary-repository.js";
import { DrizzleMeterEventRepository, type MeterEventInsert } from "./meter-event-repository.js";

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

function makeMeterEvent(
  overrides: Partial<MeterEventInsert> & { tenant: string; timestamp: number },
): MeterEventInsert {
  return {
    id: crypto.randomUUID(),
    cost: 1000,
    charge: 2000,
    capability: "llm",
    provider: "openai",
    sessionId: null,
    duration: null,
    usageUnits: null,
    usageUnitType: null,
    tier: null,
    metadata: null,
    ...overrides,
  };
}

describe("DrizzleMeterEventRepository", () => {
  let repo: DrizzleMeterEventRepository;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleMeterEventRepository(db);
  });

  describe("existsById", () => {
    it("returns false when event does not exist", async () => {
      expect(await repo.existsById(crypto.randomUUID())).toBe(false);
    });

    it("returns true after event is inserted", async () => {
      const event = makeMeterEvent({ tenant: "t1", timestamp: 1000 });
      await repo.insertBatch([event]);
      expect(await repo.existsById(event.id)).toBe(true);
    });
  });

  describe("insertBatch", () => {
    it("inserts nothing when given empty array", async () => {
      await repo.insertBatch([]);
      const rows = await repo.queryByTenant("any", 100);
      expect(rows).toEqual([]);
    });

    it("inserts a single event", async () => {
      const event = makeMeterEvent({ tenant: "t1", timestamp: 5000 });
      await repo.insertBatch([event]);
      const rows = await repo.queryByTenant("t1", 100);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(event.id);
      expect(rows[0].tenant).toBe("t1");
      expect(rows[0].cost).toBe(1000);
      expect(rows[0].charge).toBe(2000);
      expect(rows[0].capability).toBe("llm");
      expect(rows[0].provider).toBe("openai");
      expect(rows[0].timestamp).toBe(5000);
    });

    it("inserts multiple events in a batch", async () => {
      const events = [
        makeMeterEvent({ tenant: "t1", timestamp: 1000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 2000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 3000 }),
      ];
      await repo.insertBatch(events);
      const rows = await repo.queryByTenant("t1", 100);
      expect(rows).toHaveLength(3);
    });

    it("rejects duplicate event IDs", async () => {
      const id = crypto.randomUUID();
      const e1 = makeMeterEvent({ id, tenant: "t1", timestamp: 1000 });
      const e2 = makeMeterEvent({ id, tenant: "t1", timestamp: 2000 });
      await repo.insertBatch([e1]);
      await expect(repo.insertBatch([e2])).rejects.toThrow();
    });

    it("persists optional fields (sessionId, duration, usageUnits, tier, metadata)", async () => {
      const event = makeMeterEvent({
        tenant: "t1",
        timestamp: 1000,
        sessionId: "sess-1",
        duration: 5000,
        usageUnits: 150,
        usageUnitType: "tokens",
        tier: "wopr",
        metadata: '{"model":"gpt-4"}',
      });
      await repo.insertBatch([event]);
      const rows = await repo.queryByTenant("t1", 100);
      expect(rows[0].session_id).toBe("sess-1");
      expect(rows[0].duration).toBe(5000);
      expect(rows[0].usage_units).toBeCloseTo(150);
      expect(rows[0].usage_unit_type).toBe("tokens");
      expect(rows[0].tier).toBe("wopr");
      expect(rows[0].metadata).toBe('{"model":"gpt-4"}');
    });
  });

  describe("queryByTenant", () => {
    it("returns empty array when no events for tenant", async () => {
      const rows = await repo.queryByTenant("nonexistent", 100);
      expect(rows).toEqual([]);
    });

    it("returns only events for the specified tenant", async () => {
      await repo.insertBatch([
        makeMeterEvent({ tenant: "t1", timestamp: 1000 }),
        makeMeterEvent({ tenant: "t2", timestamp: 2000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 3000 }),
      ]);
      const rows = await repo.queryByTenant("t1", 100);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenant === "t1")).toBe(true);
    });

    it("orders results by timestamp descending", async () => {
      await repo.insertBatch([
        makeMeterEvent({ tenant: "t1", timestamp: 1000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 3000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 2000 }),
      ]);
      const rows = await repo.queryByTenant("t1", 100);
      expect(rows[0].timestamp).toBe(3000);
      expect(rows[1].timestamp).toBe(2000);
      expect(rows[2].timestamp).toBe(1000);
    });

    it("respects the limit parameter", async () => {
      await repo.insertBatch([
        makeMeterEvent({ tenant: "t1", timestamp: 1000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 2000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 3000 }),
      ]);
      const rows = await repo.queryByTenant("t1", 2);
      expect(rows).toHaveLength(2);
      expect(rows[0].timestamp).toBe(3000);
      expect(rows[1].timestamp).toBe(2000);
    });
  });
});

function makeSummaryInsert(
  overrides: Partial<UsageSummaryInsert> & { tenant: string; windowStart: number; windowEnd: number },
): UsageSummaryInsert {
  return {
    id: crypto.randomUUID(),
    capability: "llm",
    provider: "openai",
    eventCount: 1,
    totalCost: 1000,
    totalCharge: 2000,
    totalDuration: 0,
    ...overrides,
  };
}

describe("DrizzleUsageSummaryRepository", () => {
  let repo: DrizzleUsageSummaryRepository;
  let eventRepo: DrizzleMeterEventRepository;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleUsageSummaryRepository(db);
    eventRepo = new DrizzleMeterEventRepository(db);
  });

  describe("getLastWindowEnd", () => {
    it("returns 0 when no summaries exist", async () => {
      expect(await repo.getLastWindowEnd()).toBe(0);
    });

    it("returns the maximum windowEnd across all summaries", async () => {
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 0, windowEnd: 1000 }));
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 1000, windowEnd: 5000 }));
      await repo.insertSummary(makeSummaryInsert({ tenant: "t2", windowStart: 0, windowEnd: 3000 }));
      expect(await repo.getLastWindowEnd()).toBe(5000);
    });
  });

  describe("getEarliestEventTimestamp", () => {
    it("returns null when no meter events exist", async () => {
      expect(await repo.getEarliestEventTimestamp(Date.now())).toBeNull();
    });

    it("returns null when no events exist before the given time", async () => {
      await eventRepo.insertBatch([makeMeterEvent({ tenant: "t1", timestamp: 5000 })]);
      expect(await repo.getEarliestEventTimestamp(5000)).toBeNull();
    });

    it("returns the earliest timestamp before the given time", async () => {
      await eventRepo.insertBatch([
        makeMeterEvent({ tenant: "t1", timestamp: 1000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 3000 }),
        makeMeterEvent({ tenant: "t1", timestamp: 5000 }),
      ]);
      expect(await repo.getEarliestEventTimestamp(4000)).toBe(1000);
    });
  });

  describe("getAggregatedEvents", () => {
    it("returns empty array when no events in window", async () => {
      const result = await repo.getAggregatedEvents(0, 10000);
      expect(result).toEqual([]);
    });

    it("aggregates events within [windowStart, windowEnd) grouped by tenant/capability/provider", async () => {
      await eventRepo.insertBatch([
        makeMeterEvent({
          tenant: "t1",
          timestamp: 1000,
          cost: 100,
          charge: 200,
          capability: "llm",
          provider: "openai",
        }),
        makeMeterEvent({
          tenant: "t1",
          timestamp: 2000,
          cost: 300,
          charge: 400,
          capability: "llm",
          provider: "openai",
        }),
        makeMeterEvent({
          tenant: "t1",
          timestamp: 3000,
          cost: 500,
          charge: 600,
          capability: "tts",
          provider: "kokoro",
        }),
      ]);
      const result = await repo.getAggregatedEvents(0, 10000);
      expect(result).toHaveLength(2);

      const llmGroup = result.find((r) => r.capability === "llm");
      expect(llmGroup).toEqual(
        expect.objectContaining({
          tenant: "t1",
          capability: "llm",
          provider: "openai",
          eventCount: 2,
          totalCost: 400,
          totalCharge: 600,
        }),
      );

      const ttsGroup = result.find((r) => r.capability === "tts");
      expect(ttsGroup).toEqual(
        expect.objectContaining({
          tenant: "t1",
          capability: "tts",
          provider: "kokoro",
          eventCount: 1,
          totalCost: 500,
          totalCharge: 600,
        }),
      );
    });

    it("excludes events at or after windowEnd (half-open interval)", async () => {
      await eventRepo.insertBatch([
        makeMeterEvent({ tenant: "t1", timestamp: 999 }),
        makeMeterEvent({ tenant: "t1", timestamp: 1000 }), // at windowEnd — excluded
      ]);
      const result = await repo.getAggregatedEvents(0, 1000);
      expect(result).toHaveLength(1);
      expect(result[0].eventCount).toBe(1);
    });

    it("includes events exactly at windowStart", async () => {
      await eventRepo.insertBatch([makeMeterEvent({ tenant: "t1", timestamp: 5000 })]);
      const result = await repo.getAggregatedEvents(5000, 10000);
      expect(result).toHaveLength(1);
      expect(result[0].eventCount).toBe(1);
    });

    it("aggregates duration with COALESCE (null durations become 0)", async () => {
      await eventRepo.insertBatch([
        makeMeterEvent({ tenant: "t1", timestamp: 1000, duration: null }),
        makeMeterEvent({ tenant: "t1", timestamp: 2000, duration: 5000 }),
      ]);
      const result = await repo.getAggregatedEvents(0, 10000);
      expect(result[0].totalDuration).toBe(5000);
    });
  });

  describe("insertSummary / insertSummariesBatch", () => {
    it("inserts a single summary row", async () => {
      const s = makeSummaryInsert({ tenant: "t1", windowStart: 0, windowEnd: 1000 });
      await repo.insertSummary(s);
      const rows = await repo.querySummaries("t1");
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant).toBe("t1");
    });

    it("insertSummariesBatch inserts multiple rows", async () => {
      const summaries = [
        makeSummaryInsert({ tenant: "t1", windowStart: 0, windowEnd: 1000 }),
        makeSummaryInsert({ tenant: "t1", windowStart: 1000, windowEnd: 2000 }),
      ];
      await repo.insertSummariesBatch(summaries);
      const rows = await repo.querySummaries("t1");
      expect(rows).toHaveLength(2);
    });

    it("insertSummariesBatch with empty array does nothing", async () => {
      await repo.insertSummariesBatch([]);
      const rows = await repo.querySummaries("t1");
      expect(rows).toEqual([]);
    });
  });

  describe("querySummaries", () => {
    it("returns empty array when no summaries for tenant", async () => {
      const rows = await repo.querySummaries("nonexistent");
      expect(rows).toEqual([]);
    });

    it("returns only summaries for the given tenant", async () => {
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 0, windowEnd: 1000 }));
      await repo.insertSummary(makeSummaryInsert({ tenant: "t2", windowStart: 0, windowEnd: 1000 }));
      const rows = await repo.querySummaries("t1");
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant).toBe("t1");
    });

    it("filters by since (windowStart >= since)", async () => {
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 1000, windowEnd: 2000 }));
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 3000, windowEnd: 4000 }));

      const rows = await repo.querySummaries("t1", { since: 2000 });
      expect(rows).toHaveLength(1);
      expect(rows[0].window_start).toBe(3000);
    });

    it("filters by until (windowEnd <= until)", async () => {
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 1000, windowEnd: 2000 }));
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 3000, windowEnd: 4000 }));

      const rows = await repo.querySummaries("t1", { until: 2000 });
      expect(rows).toHaveLength(1);
      expect(rows[0].window_end).toBe(2000);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: i * 1000, windowEnd: (i + 1) * 1000 }));
      }
      const rows = await repo.querySummaries("t1", { limit: 3 });
      expect(rows).toHaveLength(3);
    });

    it("orders by windowStart descending", async () => {
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 1000, windowEnd: 2000 }));
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 3000, windowEnd: 4000 }));
      await repo.insertSummary(makeSummaryInsert({ tenant: "t1", windowStart: 2000, windowEnd: 3000 }));

      const rows = await repo.querySummaries("t1");
      expect(rows[0].window_start).toBe(3000);
      expect(rows[1].window_start).toBe(2000);
      expect(rows[2].window_start).toBe(1000);
    });

    it("returns correct UsageSummary shape", async () => {
      await repo.insertSummary(
        makeSummaryInsert({
          tenant: "t1",
          windowStart: 0,
          windowEnd: 1000,
          capability: "voice",
          provider: "deepgram",
          eventCount: 5,
          totalCost: 500,
          totalCharge: 1000,
          totalDuration: 30000,
        }),
      );
      const rows = await repo.querySummaries("t1");
      expect(rows[0]).toEqual({
        tenant: "t1",
        capability: "voice",
        provider: "deepgram",
        event_count: 5,
        total_cost: 500,
        total_charge: 1000,
        total_duration: 30000,
        window_start: 0,
        window_end: 1000,
      });
    });
  });

  describe("getTenantTotal", () => {
    it("returns zeros when no summaries exist for tenant", async () => {
      const result = await repo.getTenantTotal("nonexistent", 0);
      expect(result).toEqual({ totalCost: 0, totalCharge: 0, eventCount: 0 });
    });

    it("sums cost, charge, and eventCount for summaries since given time", async () => {
      await repo.insertSummary(
        makeSummaryInsert({
          tenant: "t1",
          windowStart: 1000,
          windowEnd: 2000,
          totalCost: 100,
          totalCharge: 200,
          eventCount: 3,
        }),
      );
      await repo.insertSummary(
        makeSummaryInsert({
          tenant: "t1",
          windowStart: 3000,
          windowEnd: 4000,
          totalCost: 400,
          totalCharge: 500,
          eventCount: 7,
        }),
      );
      // Before the since threshold
      await repo.insertSummary(
        makeSummaryInsert({
          tenant: "t1",
          windowStart: 0,
          windowEnd: 500,
          totalCost: 9999,
          totalCharge: 9999,
          eventCount: 99,
        }),
      );

      const result = await repo.getTenantTotal("t1", 1000);
      expect(result).toEqual({ totalCost: 500, totalCharge: 700, eventCount: 10 });
    });

    it("isolates totals per tenant", async () => {
      await repo.insertSummary(
        makeSummaryInsert({
          tenant: "t1",
          windowStart: 1000,
          windowEnd: 2000,
          totalCost: 100,
          totalCharge: 200,
          eventCount: 1,
        }),
      );
      await repo.insertSummary(
        makeSummaryInsert({
          tenant: "t2",
          windowStart: 1000,
          windowEnd: 2000,
          totalCost: 999,
          totalCharge: 999,
          eventCount: 99,
        }),
      );

      const result = await repo.getTenantTotal("t1", 0);
      expect(result).toEqual({ totalCost: 100, totalCharge: 200, eventCount: 1 });
    });
  });
});
