import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { createTestDb } from "../../src/test/db.js";
import { Credit } from "../../src/monetization/credit.js";
import { DrizzleMeterEmitter as MeterEmitter } from "../../src/monetization/metering/emitter.js";
import { DrizzleMeterEventRepository } from "../../src/monetization/metering/meter-event-repository.js";
import { DrizzleMeterAggregator as MeterAggregator } from "../../src/monetization/metering/aggregator.js";
import { DrizzleUsageSummaryRepository } from "../../src/monetization/metering/drizzle-usage-summary-repository.js";
import { MeterWAL } from "../../src/monetization/metering/wal.js";
import { MeterDLQ } from "../../src/monetization/metering/dlq.js";
import type { MeterEvent } from "../../src/monetization/metering/types.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function makeEvent(overrides: Partial<MeterEvent> = {}): MeterEvent {
  return {
    tenant: "tenant-1",
    cost: Credit.fromDollars(0.001),
    charge: Credit.fromDollars(0.002),
    capability: "embeddings",
    provider: "openai",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("E2E: metering reconciliation", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let walPath: string;
  let dlqPath: string;

  beforeEach(async () => {
    const suffix = `${Date.now()}-${randomUUID()}`;
    walPath = `/tmp/wopr-e2e-meter-wal-${suffix}.jsonl`;
    dlqPath = `/tmp/wopr-e2e-meter-dlq-${suffix}.jsonl`;
    ({ db, pool } = await createTestDb());
  });

  afterEach(async () => {
    await pool.close();
    try {
      unlinkSync(walPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(dlqPath);
    } catch {
      /* ignore */
    }
  });

  describe("normal flow — emit, flush, aggregate", () => {
    it("emits 10 events, flushes to DB, and aggregates correct usage summary", async () => {
      const repo = new DrizzleMeterEventRepository(db);
      const emitter = new MeterEmitter(repo, {
        flushIntervalMs: 60_000,
        batchSize: 100,
        walPath,
        dlqPath,
      });
      await emitter.ready;

      const WINDOW_MS = 1000;
      // Use a timestamp in a past completed window
      const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS - WINDOW_MS;
      const eventTimestamp = windowStart + 100;

      const costPerEvent = Credit.fromDollars(0.001);
      const chargePerEvent = Credit.fromDollars(0.002);

      // Emit 10 events
      for (let i = 0; i < 10; i++) {
        emitter.emit(
          makeEvent({
            tenant: "tenant-recon",
            cost: costPerEvent,
            charge: chargePerEvent,
            timestamp: eventTimestamp + i,
          }),
        );
      }

      // Flush to DB
      const flushed = await emitter.flush();
      expect(flushed).toBe(10);

      // Aggregate
      const summaryRepo = new DrizzleUsageSummaryRepository(db);
      const aggregator = new MeterAggregator(summaryRepo, { windowMs: WINDOW_MS });
      const inserted = await aggregator.aggregate(windowStart + 2 * WINDOW_MS);
      expect(inserted).toBeGreaterThanOrEqual(1);

      try {
        // Verify usage summary
        const total = await aggregator.getTenantTotal("tenant-recon", 0);
        expect(total.eventCount).toBe(10);
        expect(total.totalCost).toBe(costPerEvent.toRaw() * 10);
        expect(total.totalCharge).toBe(chargePerEvent.toRaw() * 10);
      } finally {
        emitter.close();
      }
    });
  });

  describe("WAL replay after crash", () => {
    it("recovers events from WAL when emitter restarts before flush", async () => {
      const repo = new DrizzleMeterEventRepository(db);

      // Phase 1: Write events directly to WAL (simulating crash before flush)
      const wal = new MeterWAL(walPath);
      for (let i = 0; i < 5; i++) {
        wal.append(
          makeEvent({
            tenant: "tenant-crash",
            timestamp: Date.now() - 5000 + i,
          }),
        );
      }

      // WAL should have 5 events, DB should have 0
      expect(wal.count()).toBe(5);
      const preRows = await repo.queryByTenant("tenant-crash", 100);
      expect(preRows).toHaveLength(0);

      // Phase 2: Create new emitter — it should replay WAL on startup
      const emitter = new MeterEmitter(repo, {
        flushIntervalMs: 60_000,
        batchSize: 100,
        walPath,
        dlqPath,
      });
      await emitter.ready;

      // After ready, events should be in DB
      const postRows = await repo.queryByTenant("tenant-crash", 100);
      expect(postRows).toHaveLength(5);

      try {
        // WAL should be cleared after successful replay
        expect(wal.isEmpty()).toBe(true);
      } finally {
        emitter.close();
      }
    });
  });

  describe("DLQ processing", () => {
    it("moves events to DLQ after max retries and preserves failure metadata", async () => {
      const dlq = new MeterDLQ(dlqPath);

      // Inject 3 failed events into DLQ with error metadata
      const failedEvents: Array<MeterEvent & { id: string }> = [];
      for (let i = 0; i < 3; i++) {
        const ev = {
          ...makeEvent({
            tenant: "tenant-dlq",
            timestamp: Date.now() - 3000 + i,
          }),
          id: randomUUID(),
        };
        failedEvents.push(ev);
        dlq.append(ev, `Simulated DB error #${i}`, 3);
      }

      // Verify DLQ has 3 entries
      expect(dlq.count()).toBe(3);

      // Read back and verify metadata
      const entries = dlq.readAll();
      expect(entries).toHaveLength(3);

      for (let i = 0; i < 3; i++) {
        expect(entries[i].id).toBe(failedEvents[i].id);
        expect(entries[i].tenant).toBe("tenant-dlq");
        expect(entries[i].dlq_error).toBe(`Simulated DB error #${i}`);
        expect(entries[i].dlq_retries).toBe(3);
        expect(entries[i].dlq_timestamp).toBeGreaterThan(0);
      }
    });

    it("emitter moves events to DLQ after max retries on flush failure", async () => {
      // Create a repo that always fails insertBatch
      const failingRepo = {
        existsById: async () => false,
        insertBatch: async () => {
          throw new Error("DB connection lost");
        },
        queryByTenant: async () => [],
      } as unknown as DrizzleMeterEventRepository;

      const MAX_RETRIES = 2;
      const emitter = new MeterEmitter(failingRepo, {
        flushIntervalMs: 60_000,
        batchSize: 100,
        walPath,
        dlqPath,
        maxRetries: MAX_RETRIES,
      });
      await emitter.ready;

      // Emit one event
      emitter.emit(makeEvent({ tenant: "tenant-dlq-retry" }));

      // Flush MAX_RETRIES times — each flush fails and increments retry count
      for (let i = 0; i < MAX_RETRIES; i++) {
        await emitter.flush();
      }

      // After max retries, event should be in DLQ
      const dlq = new MeterDLQ(dlqPath);
      const entries = dlq.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].tenant).toBe("tenant-dlq-retry");
      expect(entries[0].dlq_error).toContain("DB connection lost");
      expect(entries[0].dlq_retries).toBe(MAX_RETRIES);

      try {
        // Buffer should be empty (event moved to DLQ, not retried)
        expect(emitter.pending).toBe(0);
      } finally {
        emitter.close();
      }
    });
  });
});
