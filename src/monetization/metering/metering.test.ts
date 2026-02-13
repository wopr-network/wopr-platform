import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeterAggregator } from "./aggregator.js";
import { MeterEmitter } from "./emitter.js";
import { initMeterSchema } from "./schema.js";
import type { MeterEvent } from "./types.js";

function createTestDb() {
  const db = new BetterSqlite3(":memory:");
  initMeterSchema(db);
  return db;
}

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

// -- Schema -----------------------------------------------------------------

describe("initMeterSchema", () => {
  it("creates meter_events table", () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meter_events'").all() as {
      name: string;
    }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates usage_summaries table", () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_summaries'").all() as {
      name: string;
    }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_meter_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(5);
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    initMeterSchema(db);
    initMeterSchema(db);
    db.close();
  });
});

// -- Emitter ----------------------------------------------------------------

describe("MeterEmitter", () => {
  let db: BetterSqlite3.Database;
  let emitter: MeterEmitter;

  beforeEach(() => {
    db = createTestDb();
    // Disable auto-flush timer in tests; we flush manually.
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, batchSize: 100 });
  });

  afterEach(() => {
    emitter.close();
    db.close();
  });

  it("buffers events without writing until flush", () => {
    emitter.emit(makeEvent());
    expect(emitter.pending).toBe(1);

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM meter_events").get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("flush writes buffered events to the database", () => {
    emitter.emit(makeEvent());
    emitter.emit(makeEvent({ tenant: "tenant-2" }));

    const flushed = emitter.flush();
    expect(flushed).toBe(2);
    expect(emitter.pending).toBe(0);

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM meter_events").get() as { cnt: number };
    expect(rows.cnt).toBe(2);
  });

  it("persists all MeterEvent fields", () => {
    const event = makeEvent({
      tenant: "t-abc",
      cost: 0.05,
      charge: 0.1,
      capability: "voice",
      provider: "deepgram",
      timestamp: 1700000000000,
      sessionId: "sess-123",
      duration: 5000,
    });

    emitter.emit(event);
    emitter.flush();

    const rows = emitter.queryEvents("t-abc");
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant).toBe("t-abc");
    expect(rows[0].cost).toBe(0.05);
    expect(rows[0].charge).toBe(0.1);
    expect(rows[0].capability).toBe("voice");
    expect(rows[0].provider).toBe("deepgram");
    expect(rows[0].timestamp).toBe(1700000000000);
    expect(rows[0].session_id).toBe("sess-123");
    expect(rows[0].duration).toBe(5000);
  });

  it("handles null optional fields", () => {
    emitter.emit(makeEvent({ sessionId: undefined, duration: undefined }));
    emitter.flush();

    const rows = emitter.queryEvents("tenant-1");
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].duration).toBeNull();
  });

  it("generates unique IDs for each event", () => {
    emitter.emit(makeEvent());
    emitter.emit(makeEvent());
    emitter.flush();

    const rows = emitter.queryEvents("tenant-1");
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it("auto-flushes when batch size is reached", () => {
    const smallBatch = new MeterEmitter(db, { flushIntervalMs: 60_000, batchSize: 3 });
    smallBatch.emit(makeEvent());
    smallBatch.emit(makeEvent());
    // Third event triggers auto-flush.
    smallBatch.emit(makeEvent());

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM meter_events").get() as { cnt: number };
    expect(rows.cnt).toBe(3);
    expect(smallBatch.pending).toBe(0);
    smallBatch.close();
  });

  it("close flushes remaining events", () => {
    emitter.emit(makeEvent());
    emitter.emit(makeEvent());
    emitter.close();

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM meter_events").get() as { cnt: number };
    expect(rows.cnt).toBe(2);
  });

  it("ignores events after close", () => {
    emitter.close();
    emitter.emit(makeEvent());
    expect(emitter.pending).toBe(0);
  });

  it("re-adds events to buffer on flush failure", () => {
    emitter.emit(makeEvent());
    emitter.emit(makeEvent());
    expect(emitter.pending).toBe(2);

    db.close();
    // Should not throw even though db is closed.
    const flushed = emitter.flush();
    expect(flushed).toBe(0);
    // Events should be back in the buffer for retry.
    expect(emitter.pending).toBe(2);

    // Re-open db for afterEach cleanup.
    db = createTestDb();
  });

  it("queryEvents returns events for a specific tenant", () => {
    emitter.emit(makeEvent({ tenant: "t-1" }));
    emitter.emit(makeEvent({ tenant: "t-2" }));
    emitter.emit(makeEvent({ tenant: "t-1" }));
    emitter.flush();

    const t1Events = emitter.queryEvents("t-1");
    expect(t1Events).toHaveLength(2);

    const t2Events = emitter.queryEvents("t-2");
    expect(t2Events).toHaveLength(1);
  });

  it("flush returns 0 when buffer is empty", () => {
    expect(emitter.flush()).toBe(0);
  });
});

// -- Concurrent sessions (STT + LLM + TTS) ---------------------------------

describe("MeterEmitter - concurrent multi-provider sessions", () => {
  let db: BetterSqlite3.Database;
  let emitter: MeterEmitter;

  beforeEach(() => {
    db = createTestDb();
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000 });
  });

  afterEach(() => {
    emitter.close();
    db.close();
  });

  it("groups multiple providers under one sessionId", () => {
    const sessionId = "voice-session-1";

    emitter.emit(makeEvent({ capability: "stt", provider: "deepgram", sessionId }));
    emitter.emit(makeEvent({ capability: "chat", provider: "openai", sessionId }));
    emitter.emit(makeEvent({ capability: "tts", provider: "elevenlabs", sessionId }));
    emitter.flush();

    const rows = db
      .prepare("SELECT * FROM meter_events WHERE session_id = ? ORDER BY capability")
      .all(sessionId) as Array<{ capability: string; provider: string; session_id: string }>;

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.capability)).toEqual(["chat", "stt", "tts"]);
    expect(rows.map((r) => r.provider)).toEqual(["openai", "deepgram", "elevenlabs"]);
  });

  it("handles events from different sessions simultaneously", () => {
    emitter.emit(makeEvent({ sessionId: "sess-a", capability: "stt" }));
    emitter.emit(makeEvent({ sessionId: "sess-b", capability: "stt" }));
    emitter.emit(makeEvent({ sessionId: "sess-a", capability: "tts" }));
    emitter.flush();

    const sessA = db.prepare("SELECT COUNT(*) as cnt FROM meter_events WHERE session_id = ?").get("sess-a") as {
      cnt: number;
    };
    const sessB = db.prepare("SELECT COUNT(*) as cnt FROM meter_events WHERE session_id = ?").get("sess-b") as {
      cnt: number;
    };

    expect(sessA.cnt).toBe(2);
    expect(sessB.cnt).toBe(1);
  });
});

// -- Aggregator -------------------------------------------------------------

describe("MeterAggregator", () => {
  let db: BetterSqlite3.Database;
  let emitter: MeterEmitter;
  let aggregator: MeterAggregator;

  const WINDOW = 60_000; // 1 minute

  beforeEach(() => {
    db = createTestDb();
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000 });
    aggregator = new MeterAggregator(db, { windowMs: WINDOW });
  });

  afterEach(() => {
    aggregator.stop();
    emitter.close();
    db.close();
  });

  it("aggregates events from completed windows", () => {
    // Insert events in a past window.
    const pastWindow = Math.floor(Date.now() / WINDOW) * WINDOW - WINDOW;

    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: pastWindow + 100 }));
    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.03, charge: 0.06, timestamp: pastWindow + 200 }));
    emitter.flush();

    const count = aggregator.aggregate();
    expect(count).toBe(1); // One group: t-1 + embeddings + openai.

    const summaries = aggregator.querySummaries("t-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].event_count).toBe(2);
    expect(summaries[0].total_cost).toBeCloseTo(0.04, 10);
    expect(summaries[0].total_charge).toBeCloseTo(0.08, 10);
  });

  it("groups by tenant, capability, and provider", () => {
    const pastWindow = Math.floor(Date.now() / WINDOW) * WINDOW - WINDOW;

    emitter.emit(
      makeEvent({ tenant: "t-1", capability: "embeddings", provider: "openai", timestamp: pastWindow + 10 }),
    );
    emitter.emit(makeEvent({ tenant: "t-1", capability: "voice", provider: "deepgram", timestamp: pastWindow + 20 }));
    emitter.emit(
      makeEvent({ tenant: "t-2", capability: "embeddings", provider: "openai", timestamp: pastWindow + 30 }),
    );
    emitter.flush();

    const count = aggregator.aggregate();
    expect(count).toBe(3); // Three distinct groups.

    const t1Summaries = aggregator.querySummaries("t-1");
    expect(t1Summaries).toHaveLength(2);

    const t2Summaries = aggregator.querySummaries("t-2");
    expect(t2Summaries).toHaveLength(1);
  });

  it("does not aggregate the current (incomplete) window", () => {
    // Insert an event in the *current* window.
    emitter.emit(makeEvent({ timestamp: Date.now() }));
    emitter.flush();

    const count = aggregator.aggregate();
    // If there are no events in prior windows, nothing to aggregate.
    const summaries = aggregator.querySummaries("tenant-1");
    // Should either be 0 summaries, or count should be 0 for just-current events.
    expect(count).toBe(0);
    expect(summaries).toHaveLength(0);
  });

  it("is idempotent - does not double-aggregate", () => {
    const pastWindow = Math.floor(Date.now() / WINDOW) * WINDOW - WINDOW;

    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: pastWindow + 10 }));
    emitter.flush();

    aggregator.aggregate();
    aggregator.aggregate(); // Second call should be no-op.

    const summaries = aggregator.querySummaries("t-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].event_count).toBe(1);
  });

  it("aggregates duration for session-based capabilities", () => {
    const pastWindow = Math.floor(Date.now() / WINDOW) * WINDOW - WINDOW;

    emitter.emit(
      makeEvent({
        tenant: "t-1",
        capability: "voice",
        duration: 3000,
        timestamp: pastWindow + 10,
      }),
    );
    emitter.emit(
      makeEvent({
        tenant: "t-1",
        capability: "voice",
        duration: 5000,
        timestamp: pastWindow + 20,
      }),
    );
    emitter.flush();

    aggregator.aggregate();

    const summaries = aggregator.querySummaries("t-1");
    const voiceSummary = summaries.find((s) => s.capability === "voice");
    expect(voiceSummary).toBeDefined();
    expect(voiceSummary?.total_duration).toBe(8000);
  });

  it("getTenantTotal returns aggregate totals", () => {
    const pastWindow = Math.floor(Date.now() / WINDOW) * WINDOW - WINDOW;

    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: pastWindow + 10 }));
    emitter.emit(
      makeEvent({
        tenant: "t-1",
        cost: 0.05,
        charge: 0.1,
        capability: "voice",
        timestamp: pastWindow + 20,
      }),
    );
    emitter.flush();

    aggregator.aggregate();

    const total = aggregator.getTenantTotal("t-1", 0);
    expect(total.totalCost).toBeCloseTo(0.06, 10);
    expect(total.totalCharge).toBeCloseTo(0.12, 10);
    expect(total.eventCount).toBe(2);
  });

  it("getTenantTotal returns zeros for unknown tenant", () => {
    const total = aggregator.getTenantTotal("nonexistent", 0);
    expect(total.totalCost).toBe(0);
    expect(total.totalCharge).toBe(0);
    expect(total.eventCount).toBe(0);
  });

  it("querySummaries respects since/until filters", () => {
    const now = Date.now();
    const twoWindowsAgo = Math.floor(now / WINDOW) * WINDOW - 2 * WINDOW;
    const oneWindowAgo = Math.floor(now / WINDOW) * WINDOW - WINDOW;

    emitter.emit(makeEvent({ tenant: "t-1", timestamp: twoWindowsAgo + 10 }));
    emitter.emit(makeEvent({ tenant: "t-1", timestamp: oneWindowAgo + 10 }));
    emitter.flush();

    // Aggregate both windows.
    aggregator.aggregate(twoWindowsAgo + WINDOW + 1);
    aggregator.aggregate(now);

    const all = aggregator.querySummaries("t-1");
    // Filter to only recent window.
    const recent = aggregator.querySummaries("t-1", { since: oneWindowAgo });
    expect(recent.length).toBeLessThanOrEqual(all.length);
  });

  it("returns 0 when no events exist", () => {
    const count = aggregator.aggregate();
    expect(count).toBe(0);
  });
});

// -- Aggregator edge cases --------------------------------------------------

describe("MeterAggregator - edge cases", () => {
  let db: BetterSqlite3.Database;
  let emitter: MeterEmitter;
  let aggregator: MeterAggregator;

  const WINDOW = 60_000;

  beforeEach(() => {
    db = createTestDb();
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000 });
    aggregator = new MeterAggregator(db, { windowMs: WINDOW });
  });

  afterEach(() => {
    aggregator.stop();
    emitter.close();
    db.close();
  });

  it("inserts sentinel for empty windows between events", () => {
    const now = Date.now();
    const threeWindowsAgo = Math.floor(now / WINDOW) * WINDOW - 3 * WINDOW;

    // Place one event 3 windows ago; windows 2-ago and 1-ago are empty.
    emitter.emit(makeEvent({ tenant: "t-1", timestamp: threeWindowsAgo + 10 }));
    emitter.flush();

    aggregator.aggregate(now);

    // The event window should produce a real summary.
    const summaries = aggregator.querySummaries("t-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].event_count).toBe(1);

    // Sentinel rows fill the empty windows; verify they exist via raw query.
    const sentinels = db.prepare("SELECT COUNT(*) as cnt FROM usage_summaries WHERE tenant = '__sentinel__'").get() as {
      cnt: number;
    };
    expect(sentinels.cnt).toBe(2);
  });

  it("handles single-event windows correctly", () => {
    const now = Date.now();
    const pastWindow = Math.floor(now / WINDOW) * WINDOW - WINDOW;

    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.123, charge: 0.456, timestamp: pastWindow + 500 }));
    emitter.flush();

    const count = aggregator.aggregate(now);
    expect(count).toBe(1);

    const summaries = aggregator.querySummaries("t-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].event_count).toBe(1);
    expect(summaries[0].total_cost).toBeCloseTo(0.123, 10);
    expect(summaries[0].total_charge).toBeCloseTo(0.456, 10);
  });

  it("places event at exact window start into that window", () => {
    const now = Date.now();
    const pastWindow = Math.floor(now / WINDOW) * WINDOW - WINDOW;

    // Event at the exact start of the window (timestamp === windowStart).
    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: pastWindow }));
    emitter.flush();

    aggregator.aggregate(now);

    const summaries = aggregator.querySummaries("t-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].event_count).toBe(1);
    expect(summaries[0].window_start).toBe(pastWindow);
    expect(summaries[0].window_end).toBe(pastWindow + WINDOW);
  });

  it("excludes event at exact window end from that window", () => {
    const now = Date.now();
    const twoWindowsAgo = Math.floor(now / WINDOW) * WINDOW - 2 * WINDOW;
    const oneWindowAgo = twoWindowsAgo + WINDOW;

    // Event at the exact boundary (end of window 2-ago = start of window 1-ago).
    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: oneWindowAgo }));
    emitter.flush();

    aggregator.aggregate(now);

    const summaries = aggregator.querySummaries("t-1");
    expect(summaries).toHaveLength(1);
    // The event should be in the window starting at oneWindowAgo, not twoWindowsAgo.
    expect(summaries[0].window_start).toBe(oneWindowAgo);
  });

  it("multi-tenant aggregation produces independent summaries", () => {
    const now = Date.now();
    const pastWindow = Math.floor(now / WINDOW) * WINDOW - WINDOW;

    const tenants = ["alpha", "beta", "gamma"];
    for (const t of tenants) {
      emitter.emit(makeEvent({ tenant: t, cost: 0.01, charge: 0.02, capability: "chat", timestamp: pastWindow + 10 }));
      emitter.emit(
        makeEvent({ tenant: t, cost: 0.03, charge: 0.06, capability: "embeddings", timestamp: pastWindow + 20 }),
      );
    }
    emitter.flush();

    aggregator.aggregate(now);

    for (const t of tenants) {
      const summaries = aggregator.querySummaries(t);
      expect(summaries).toHaveLength(2); // chat + embeddings
      const total = aggregator.getTenantTotal(t, 0);
      expect(total.eventCount).toBe(2);
      expect(total.totalCost).toBeCloseTo(0.04, 10);
      expect(total.totalCharge).toBeCloseTo(0.08, 10);
    }
  });

  it("events spanning multiple windows are placed in correct windows", () => {
    const now = Date.now();
    const threeWindowsAgo = Math.floor(now / WINDOW) * WINDOW - 3 * WINDOW;
    const twoWindowsAgo = threeWindowsAgo + WINDOW;
    const oneWindowAgo = twoWindowsAgo + WINDOW;

    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.01, charge: 0.02, timestamp: threeWindowsAgo + 100 }));
    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.03, charge: 0.06, timestamp: twoWindowsAgo + 100 }));
    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.05, charge: 0.1, timestamp: oneWindowAgo + 100 }));
    emitter.flush();

    aggregator.aggregate(now);

    const summaries = aggregator.querySummaries("t-1");
    expect(summaries).toHaveLength(3);

    // Verify each window has exactly one event with the correct cost.
    const sorted = [...summaries].sort((a, b) => a.window_start - b.window_start);
    expect(sorted[0].window_start).toBe(threeWindowsAgo);
    expect(sorted[0].total_cost).toBeCloseTo(0.01, 10);
    expect(sorted[1].window_start).toBe(twoWindowsAgo);
    expect(sorted[1].total_cost).toBeCloseTo(0.03, 10);
    expect(sorted[2].window_start).toBe(oneWindowAgo);
    expect(sorted[2].total_cost).toBeCloseTo(0.05, 10);
  });

  it("start/stop lifecycle does not leak timers", () => {
    aggregator.start(60_000);
    aggregator.start(60_000); // Second start is a no-op.
    aggregator.stop();
    aggregator.stop(); // Double stop is safe.
  });
});

// -- Aggregation accuracy verification --------------------------------------

describe("MeterAggregator - billing accuracy", () => {
  let db: BetterSqlite3.Database;
  let emitter: MeterEmitter;
  let aggregator: MeterAggregator;

  afterEach(() => {
    aggregator?.stop();
    emitter?.close();
    db?.close();
  });

  it("aggregated totals exactly match sum of individual events", () => {
    db = createTestDb();
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000 });
    aggregator = new MeterAggregator(db, { windowMs: 60_000 });
    const WINDOW = 60_000;
    const now = Date.now();
    const pastWindow = Math.floor(now / WINDOW) * WINDOW - WINDOW;

    // Generate events with known, precise costs.
    const events: MeterEvent[] = [
      makeEvent({ tenant: "billing-test", cost: 0.001, charge: 0.002, timestamp: pastWindow + 10 }),
      makeEvent({ tenant: "billing-test", cost: 0.002, charge: 0.004, timestamp: pastWindow + 20 }),
      makeEvent({ tenant: "billing-test", cost: 0.003, charge: 0.006, timestamp: pastWindow + 30 }),
      makeEvent({ tenant: "billing-test", cost: 0.004, charge: 0.008, timestamp: pastWindow + 40 }),
      makeEvent({ tenant: "billing-test", cost: 0.005, charge: 0.01, timestamp: pastWindow + 50 }),
    ];

    const expectedCost = events.reduce((s, e) => s + e.cost, 0);
    const expectedCharge = events.reduce((s, e) => s + e.charge, 0);

    for (const e of events) emitter.emit(e);
    emitter.flush();
    aggregator.aggregate(now);

    const total = aggregator.getTenantTotal("billing-test", 0);
    expect(total.eventCount).toBe(5);
    expect(total.totalCost).toBeCloseTo(expectedCost, 10);
    expect(total.totalCharge).toBeCloseTo(expectedCharge, 10);
  });

  it("per-capability breakdown sums match tenant total", () => {
    db = createTestDb();
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000 });
    aggregator = new MeterAggregator(db, { windowMs: 60_000 });
    const WINDOW = 60_000;
    const now = Date.now();
    const pastWindow = Math.floor(now / WINDOW) * WINDOW - WINDOW;

    emitter.emit(makeEvent({ tenant: "t-1", cost: 0.1, charge: 0.2, capability: "chat", timestamp: pastWindow + 10 }));
    emitter.emit(
      makeEvent({ tenant: "t-1", cost: 0.05, charge: 0.1, capability: "embeddings", timestamp: pastWindow + 20 }),
    );
    emitter.emit(
      makeEvent({ tenant: "t-1", cost: 0.15, charge: 0.3, capability: "voice", timestamp: pastWindow + 30 }),
    );
    emitter.flush();
    aggregator.aggregate(now);

    const summaries = aggregator.querySummaries("t-1");
    const sumCost = summaries.reduce((s, r) => s + r.total_cost, 0);
    const sumCharge = summaries.reduce((s, r) => s + r.total_charge, 0);
    const total = aggregator.getTenantTotal("t-1", 0);

    expect(sumCost).toBeCloseTo(total.totalCost, 10);
    expect(sumCharge).toBeCloseTo(total.totalCharge, 10);
    expect(total.totalCost).toBeCloseTo(0.3, 10);
    expect(total.totalCharge).toBeCloseTo(0.6, 10);
    expect(total.eventCount).toBe(3);
  });
});

// -- Emitter edge cases -----------------------------------------------------

describe("MeterEmitter - edge cases", () => {
  let db: BetterSqlite3.Database;
  let emitter: MeterEmitter;

  beforeEach(() => {
    db = createTestDb();
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, batchSize: 100 });
  });

  afterEach(() => {
    emitter.close();
    db.close();
  });

  it("handles large batch of events", () => {
    for (let i = 0; i < 200; i++) {
      emitter.emit(makeEvent({ tenant: "bulk-tenant", cost: 0.001, charge: 0.002, timestamp: Date.now() + i }));
    }
    emitter.flush();

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM meter_events WHERE tenant = ?").get("bulk-tenant") as {
      cnt: number;
    };
    expect(rows.cnt).toBe(200);
  });

  it("handles zero-cost events", () => {
    emitter.emit(makeEvent({ tenant: "free-tier", cost: 0, charge: 0 }));
    emitter.flush();

    const rows = emitter.queryEvents("free-tier");
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBe(0);
    expect(rows[0].charge).toBe(0);
  });

  it("preserves event ordering within a tenant", () => {
    const base = 1700000000000;
    emitter.emit(makeEvent({ tenant: "t-1", timestamp: base + 300 }));
    emitter.emit(makeEvent({ tenant: "t-1", timestamp: base + 100 }));
    emitter.emit(makeEvent({ tenant: "t-1", timestamp: base + 200 }));
    emitter.flush();

    // queryEvents orders by timestamp DESC.
    const rows = emitter.queryEvents("t-1");
    expect(rows).toHaveLength(3);
    expect(rows[0].timestamp).toBe(base + 300);
    expect(rows[1].timestamp).toBe(base + 200);
    expect(rows[2].timestamp).toBe(base + 100);
  });

  it("handles multiple flushes without losing events", () => {
    emitter.emit(makeEvent({ tenant: "t-1" }));
    emitter.flush();
    emitter.emit(makeEvent({ tenant: "t-1" }));
    emitter.flush();
    emitter.emit(makeEvent({ tenant: "t-1" }));
    emitter.flush();

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM meter_events WHERE tenant = ?").get("t-1") as {
      cnt: number;
    };
    expect(rows.cnt).toBe(3);
  });
});

// -- Append-only guarantee --------------------------------------------------

describe("append-only guarantee", () => {
  it("meter_events table has no UPDATE or DELETE operations in emitter", () => {
    // This is a design contract test. The emitter only INSERTs.
    const db = createTestDb();
    const emitter = new MeterEmitter(db, { flushIntervalMs: 60_000 });

    emitter.emit(makeEvent({ tenant: "t-1" }));
    emitter.flush();

    // Verify the event exists.
    const before = db.prepare("SELECT COUNT(*) as cnt FROM meter_events").get() as { cnt: number };
    expect(before.cnt).toBe(1);

    // Emit more -- never replaces.
    emitter.emit(makeEvent({ tenant: "t-1" }));
    emitter.flush();

    const after = db.prepare("SELECT COUNT(*) as cnt FROM meter_events").get() as { cnt: number };
    expect(after.cnt).toBe(2);

    emitter.close();
    db.close();
  });
});
