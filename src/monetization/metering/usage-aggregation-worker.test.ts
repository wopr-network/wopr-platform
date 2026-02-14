import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { MeterEmitter } from "./emitter.js";
import type { MeterEvent } from "./types.js";
import { UsageAggregationWorker } from "./usage-aggregation-worker.js";

const TEST_WAL_PATH = `/tmp/wopr-worker-wal-${Date.now()}.jsonl`;
const TEST_DLQ_PATH = `/tmp/wopr-worker-dlq-${Date.now()}.jsonl`;

function makeEvent(overrides: Partial<MeterEvent> = {}): MeterEvent {
  return {
    tenant: "tenant-1",
    cost: 0.001,
    charge: 0.002,
    capability: "embeddings",
    provider: "openai",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Helper: emit events, flush, then run billing aggregation. */
function pipeline(emitter: MeterEmitter, worker: UsageAggregationWorker, events: MeterEvent[], now: number): number {
  for (const e of events) {
    emitter.emit(e);
  }
  emitter.flush();
  return worker.aggregate(now);
}

// -- Schema -----------------------------------------------------------------

describe("billing_period_summaries schema", () => {
  it("creates the billing_period_summaries table", () => {
    const { sqlite } = createTestDb();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_period_summaries'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    sqlite.close();
  });

  it("creates indexes for billing_period_summaries", () => {
    const { sqlite } = createTestDb();
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_billing_period_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    sqlite.close();
  });

  it("schema creation is idempotent", () => {
    const { sqlite: s1 } = createTestDb();
    s1.close();
    const { sqlite: s2 } = createTestDb();
    s2.close();
  });
});

// -- UsageAggregationWorker -------------------------------------------------

describe("UsageAggregationWorker", () => {
  let db: DrizzleDb;
  let sqlite: import("better-sqlite3").Database;
  let emitter: MeterEmitter;
  let worker: UsageAggregationWorker;

  // Use 5-minute billing periods for easier testing.
  const BILLING_PERIOD = 300_000; // 5 minutes

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      walPath: TEST_WAL_PATH,
      dlqPath: TEST_DLQ_PATH,
    });
    worker = new UsageAggregationWorker(db, {
      periodMs: BILLING_PERIOD,
      lateArrivalGraceMs: BILLING_PERIOD, // Re-check 1 period back
    });
  });

  afterEach(() => {
    worker.stop();
    emitter.close();
    sqlite.close();

    // Clean up test files.
    try {
      unlinkSync(TEST_WAL_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
    try {
      unlinkSync(TEST_DLQ_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
  });

  it("aggregates meter events into billing period summaries", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    // Spread events across the billing period.
    const events = [
      makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: periodStart + 10_000 }),
      makeEvent({ tenant: "t-1", cost: 0.03, charge: 0.06, timestamp: periodStart + 70_000 }),
      makeEvent({ tenant: "t-1", cost: 0.02, charge: 0.04, timestamp: periodStart + 130_000 }),
    ];

    const count = pipeline(emitter, worker, events, now);
    expect(count).toBeGreaterThanOrEqual(1);

    const summaries = worker.querySummaries("t-1");
    expect(summaries.length).toBeGreaterThanOrEqual(1);

    const match = summaries.find((s) => s.period_start === periodStart);
    expect(match).toBeDefined();
    expect(match?.event_count).toBe(3);
    expect(match?.total_cost).toBeCloseTo(0.06, 10);
    expect(match?.total_charge).toBeCloseTo(0.12, 10);
  });

  it("groups by tenant, capability, and provider within each period", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [
      makeEvent({ tenant: "t-1", capability: "embeddings", provider: "openai", timestamp: periodStart + 10_000 }),
      makeEvent({ tenant: "t-1", capability: "voice", provider: "deepgram", timestamp: periodStart + 20_000 }),
      makeEvent({ tenant: "t-2", capability: "embeddings", provider: "openai", timestamp: periodStart + 30_000 }),
    ];

    const count = pipeline(emitter, worker, events, now);
    expect(count).toBe(3); // 3 distinct groups

    const t1 = worker.querySummaries("t-1");
    expect(t1).toHaveLength(2);

    const t2 = worker.querySummaries("t-2");
    expect(t2).toHaveLength(1);
  });

  it("does not aggregate the current (incomplete) billing period", () => {
    const now = Date.now();
    const currentPeriodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD;

    // Event in the current billing period.
    const events = [makeEvent({ tenant: "t-1", timestamp: currentPeriodStart + 1000 })];
    pipeline(emitter, worker, events, now);

    const summaries = worker.querySummaries("t-1");
    const currentMatch = summaries.find((s) => s.period_start === currentPeriodStart);
    expect(currentMatch).toBeUndefined();
  });

  it("is idempotent - re-running produces same results via UPSERT", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: periodStart + 10_000 })];

    pipeline(emitter, worker, events, now);

    // Run again.
    worker.aggregate(now);

    const summaries = worker.querySummaries("t-1");
    const matching = summaries.filter((s) => s.period_start === periodStart);
    expect(matching).toHaveLength(1);
    expect(matching[0].event_count).toBe(1);
  });

  it("handles late-arriving events by re-aggregating within grace period", () => {
    const now = Date.now();
    // Target the period just before the current one (within grace).
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - BILLING_PERIOD;

    // First batch.
    const batch1 = [makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: periodStart + 10_000 })];
    pipeline(emitter, worker, batch1, now);

    let summaries = worker.querySummaries("t-1");
    let match = summaries.find((s) => s.period_start === periodStart);
    expect(match).toBeDefined();
    expect(match?.event_count).toBe(1);

    // Late-arriving event in the same billing period.
    const lateEvent = makeEvent({ tenant: "t-1", cost: 0.05, charge: 0.1, timestamp: periodStart + 50_000 });
    emitter.emit(lateEvent);
    emitter.flush();

    // Re-aggregate -- the grace window covers this period, so the UPSERT updates the row.
    worker.aggregate(now);

    summaries = worker.querySummaries("t-1");
    match = summaries.find((s) => s.period_start === periodStart);
    expect(match).toBeDefined();
    expect(match?.event_count).toBe(2);
    expect(match?.total_cost).toBeCloseTo(0.06, 10);
    expect(match?.total_charge).toBeCloseTo(0.12, 10);
  });

  it("aggregates duration for session-based capabilities", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [
      makeEvent({ tenant: "t-1", capability: "voice", duration: 3000, timestamp: periodStart + 10_000 }),
      makeEvent({ tenant: "t-1", capability: "voice", duration: 7000, timestamp: periodStart + 20_000 }),
    ];

    pipeline(emitter, worker, events, now);

    const summaries = worker.querySummaries("t-1");
    const voiceMatch = summaries.find((s) => s.capability === "voice");
    expect(voiceMatch).toBeDefined();
    expect(voiceMatch?.total_duration).toBe(10_000);
  });

  it("returns 0 when no meter events exist", () => {
    const count = worker.aggregate();
    expect(count).toBe(0);
  });

  it("getBillingPeriod computes correct boundaries", () => {
    const period = worker.getBillingPeriod(BILLING_PERIOD + 1000);
    expect(period.start).toBe(BILLING_PERIOD);
    expect(period.end).toBe(BILLING_PERIOD * 2);
  });

  it("getBillingPeriod aligns to period boundaries", () => {
    const period = worker.getBillingPeriod(BILLING_PERIOD * 3);
    expect(period.start).toBe(BILLING_PERIOD * 3);
    expect(period.end).toBe(BILLING_PERIOD * 4);
  });
});

// -- getTenantPeriodTotal ---------------------------------------------------

describe("UsageAggregationWorker.getTenantPeriodTotal", () => {
  let db: DrizzleDb;
  let sqlite: import("better-sqlite3").Database;
  let emitter: MeterEmitter;
  let worker: UsageAggregationWorker;

  const BILLING_PERIOD = 300_000;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, walPath: TEST_WAL_PATH, dlqPath: TEST_DLQ_PATH });
    worker = new UsageAggregationWorker(db, { periodMs: BILLING_PERIOD, lateArrivalGraceMs: BILLING_PERIOD });
  });

  afterEach(() => {
    worker.stop();
    emitter.close();
    sqlite.close();

    // Clean up test files.
    try {
      unlinkSync(TEST_WAL_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
    try {
      unlinkSync(TEST_DLQ_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
  });

  it("returns aggregate totals across capabilities", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [
      makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, capability: "embeddings", timestamp: periodStart + 10_000 }),
      makeEvent({
        tenant: "t-1",
        cost: 0.05,
        charge: 0.1,
        capability: "voice",
        duration: 5000,
        timestamp: periodStart + 20_000,
      }),
    ];

    pipeline(emitter, worker, events, now);

    const total = worker.getTenantPeriodTotal("t-1", 0);
    expect(total.totalCost).toBeCloseTo(0.06, 10);
    expect(total.totalCharge).toBeCloseTo(0.12, 10);
    expect(total.eventCount).toBe(2);
    expect(total.totalDuration).toBe(5000);
  });

  it("returns zeros for unknown tenant", () => {
    const total = worker.getTenantPeriodTotal("nonexistent", 0);
    expect(total.totalCost).toBe(0);
    expect(total.totalCharge).toBe(0);
    expect(total.eventCount).toBe(0);
    expect(total.totalDuration).toBe(0);
  });
});

// -- Stripe Meter Records ---------------------------------------------------

describe("UsageAggregationWorker.toStripeMeterRecords", () => {
  let db: DrizzleDb;
  let sqlite: import("better-sqlite3").Database;
  let emitter: MeterEmitter;
  let worker: UsageAggregationWorker;

  const BILLING_PERIOD = 300_000;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, walPath: TEST_WAL_PATH, dlqPath: TEST_DLQ_PATH });
    worker = new UsageAggregationWorker(db, { periodMs: BILLING_PERIOD, lateArrivalGraceMs: BILLING_PERIOD });
  });

  afterEach(() => {
    worker.stop();
    emitter.close();
    sqlite.close();

    // Clean up test files.
    try {
      unlinkSync(TEST_WAL_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
    try {
      unlinkSync(TEST_DLQ_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
  });

  it("produces Stripe-compatible meter records", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [
      makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.5, capability: "embeddings", timestamp: periodStart + 10_000 }),
    ];

    pipeline(emitter, worker, events, now);

    const records = worker.toStripeMeterRecords("t-1");
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record.event_name).toBe("wopr_embeddings_usage");
    expect(record.timestamp).toBe(Math.floor(periodStart / 1000)); // seconds
    expect(record.payload.stripe_customer_id).toBe("t-1");
    expect(record.payload.value).toBe("50"); // 0.50 * 100 = 50 cents
  });

  it("maps tenant to stripe customer ID when provided", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [makeEvent({ tenant: "t-1", charge: 1.0, timestamp: periodStart + 10_000 })];

    pipeline(emitter, worker, events, now);

    const records = worker.toStripeMeterRecords("t-1", {
      customerIdMap: { "t-1": "cus_stripe_abc123" },
    });

    expect(records[0].payload.stripe_customer_id).toBe("cus_stripe_abc123");
  });

  it("uses default event name for unknown capabilities", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [makeEvent({ tenant: "t-1", capability: "custom-thing", timestamp: periodStart + 10_000 })];

    pipeline(emitter, worker, events, now);

    const records = worker.toStripeMeterRecords("t-1");
    expect(records[0].event_name).toBe("wopr_custom-thing_usage");
  });

  it("filters out zero-event summaries", () => {
    const records = worker.toStripeMeterRecords("t-1");
    expect(records).toHaveLength(0);
  });

  it("converts charge to cents as a string", () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [makeEvent({ tenant: "t-1", charge: 0.007, timestamp: periodStart + 10_000 })];

    pipeline(emitter, worker, events, now);

    const records = worker.toStripeMeterRecords("t-1");
    // 0.007 * 100 = 0.7, rounded = 1
    expect(records[0].payload.value).toBe("1");
  });
});

// -- querySummaries filters -------------------------------------------------

describe("UsageAggregationWorker.querySummaries", () => {
  let db: DrizzleDb;
  let sqlite: import("better-sqlite3").Database;
  let emitter: MeterEmitter;
  let worker: UsageAggregationWorker;

  const BILLING_PERIOD = 300_000;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, walPath: TEST_WAL_PATH, dlqPath: TEST_DLQ_PATH });
    worker = new UsageAggregationWorker(db, { periodMs: BILLING_PERIOD, lateArrivalGraceMs: BILLING_PERIOD });
  });

  afterEach(() => {
    worker.stop();
    emitter.close();
    sqlite.close();

    // Clean up test files.
    try {
      unlinkSync(TEST_WAL_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
    try {
      unlinkSync(TEST_DLQ_PATH);
    } catch {
      // Ignore if file doesn't exist.
    }
  });

  it("respects since/until filters", () => {
    const now = Date.now();
    const period1 = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 3 * BILLING_PERIOD;
    const period2 = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    const events = [
      makeEvent({ tenant: "t-1", timestamp: period1 + 10_000 }),
      makeEvent({ tenant: "t-1", timestamp: period2 + 10_000 }),
    ];

    pipeline(emitter, worker, events, now);

    const all = worker.querySummaries("t-1");
    expect(all.length).toBeGreaterThanOrEqual(2);

    const recent = worker.querySummaries("t-1", { since: period2 });
    expect(recent.length).toBeLessThanOrEqual(all.length);
    for (const s of recent) {
      expect(s.period_start).toBeGreaterThanOrEqual(period2);
    }
  });
});

// -- Start/Stop -------------------------------------------------------------

describe("UsageAggregationWorker start/stop", () => {
  it("start is idempotent", () => {
    const { db, sqlite } = createTestDb();
    const worker = new UsageAggregationWorker(db, { periodMs: 300_000, intervalMs: 60_000 });

    worker.start();
    worker.start(); // Should not throw or create duplicate timers.
    worker.stop();
    sqlite.close();
  });

  it("stop without start is safe", () => {
    const { db, sqlite } = createTestDb();
    const worker = new UsageAggregationWorker(db, { periodMs: 300_000 });

    worker.stop(); // No-op, should not throw.
    sqlite.close();
  });
});
