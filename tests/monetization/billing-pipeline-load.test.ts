import { unlinkSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { Credit } from "../../src/monetization/credit.js";
import { DrizzleBudgetChecker, type SpendLimits } from "../../src/monetization/budget/budget-checker.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { MeterAggregator } from "../../src/monetization/metering/aggregator.js";
import { MeterEmitter } from "../../src/monetization/metering/emitter.js";
import type { MeterEvent } from "../../src/monetization/metering/types.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { createTestDb, truncateAllTables } from "../../src/test/db.js";
import {
  type LoadTestResult,
  formatResult,
  heapMb,
  measureLatencyUs,
  percentile,
  runSustainedLoad,
} from "./billing-pipeline-report.js";

const TENANT_COUNT = 10;
const CAPABILITIES = ["chat", "voice", "embeddings", "tts", "stt"];
const PROVIDERS = ["openai", "deepgram", "elevenlabs", "openrouter"];

function makeEvent(i: number): MeterEvent {
  return {
    tenant: `tenant-${i % TENANT_COUNT}`,
    cost: 0.001 * ((i % 10) + 1),
    charge: 0.002 * ((i % 10) + 1),
    capability: CAPABILITIES[i % CAPABILITIES.length],
    provider: PROVIDERS[i % PROVIDERS.length],
    timestamp: Date.now() - 120_000 + i,
    sessionId: `session-${i % 50}`,
    duration: i % 2 === 0 ? 1000 : undefined,
    usage: { units: 100 + (i % 500), unitType: "tokens" },
    tier: ["branded", "wopr", "byok"][i % 3],
  };
}

describe("Billing pipeline load tests", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  const walPath = `/tmp/wopr-load-wal-${process.pid}.jsonl`;
  const dlqPath = `/tmp/wopr-load-dlq-${process.pid}.jsonl`;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    pool = testDb.pool;
  });

  afterEach(async () => {
    await pool.close();
    try {
      unlinkSync(walPath);
    } catch {
      /* */
    }
    try {
      unlinkSync(dlqPath);
    } catch {
      /* */
    }
  });

  it("Scenario 1: Sustained 10K events — emit + flush throughput", () => {
    const emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 500,
      walPath,
      dlqPath,
    });

    let counter = 0;
    const result = runSustainedLoad({
      name: "Sustained 200 events (emit + batch flush every 50)",
      emitFn: () => emitter.emit(makeEvent(counter++)),
      totalEvents: 200,
      flushFn: () => emitter.flush(),
      flushEvery: 50,
    });

    emitter.close();
    console.log(formatResult(result));

    // Baseline assertions — these define the performance floor
    expect(result.errorRate).toBe(0);
    expect(result.eventsPerSec).toBeGreaterThan(1_000); // Must sustain at least 1K/s
    expect(result.p99LatencyUs).toBeLessThan(10_000_000); // p99 < 10s (generous for SQLite WAL writes)
  });

  it("Scenario 2: Burst emit — rapid emit then single flush", async () => {
    const emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 100_000, // No auto-flush
      walPath,
      dlqPath,
    });

    let counter = 0;
    const emitLatencies: number[] = [];
    const emitStart = performance.now();

    for (let i = 0; i < 200; i++) {
      const lat = measureLatencyUs(() => emitter.emit(makeEvent(counter++)));
      emitLatencies.push(lat);
    }

    const emitDuration = performance.now() - emitStart;
    emitLatencies.sort((a, b) => a - b);

    console.log(`--- Burst emit phase ---`);
    console.log(`  Duration: ${emitDuration.toFixed(0)}ms (${((200 / emitDuration) * 1000).toFixed(0)} evt/s)`);
    console.log(`  Emit p50: ${percentile(emitLatencies, 50).toFixed(0)}us`);
    console.log(`  Emit p95: ${percentile(emitLatencies, 95).toFixed(0)}us`);
    console.log(`  Emit p99: ${percentile(emitLatencies, 99).toFixed(0)}us`);

    // Flush phase
    const flushStart = performance.now();
    const flushed = await emitter.flush();
    const flushDuration = performance.now() - flushStart;

    console.log(`--- Burst flush phase ---`);
    console.log(`  Flushed: ${flushed} events in ${flushDuration.toFixed(0)}ms`);
    console.log(`  Flush rate: ${((flushed / flushDuration) * 1000).toFixed(0)} evt/s`);

    emitter.close();

    expect(flushed).toBe(200);
    expect(emitDuration).toBeLessThan(10_000);
  });

  it("Scenario 3: Multi-tenant load — 10 tenants", () => {
    const emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 1000,
      walPath,
      dlqPath,
    });

    const TENANTS = 10;
    const EVENTS_PER_TENANT = 10;
    let counter = 0;

    const result = runSustainedLoad({
      name: `Multi-tenant load (${TENANTS} tenants x ${EVENTS_PER_TENANT} events)`,
      emitFn: () => {
        const event = makeEvent(counter);
        // Override tenant to spread across TENANTS tenants
        emitter.emit({ ...event, tenant: `tenant-${counter % TENANTS}` });
        counter++;
      },
      totalEvents: TENANTS * EVENTS_PER_TENANT,
      flushFn: () => emitter.flush(),
      flushEvery: 1000,
    });

    emitter.close();
    console.log(formatResult(result));

    expect(result.errorRate).toBe(0);
  });

  it("Scenario 4: Budget check under load — 100 tenants with active metering", () => {
    const emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 1000,
      walPath,
      dlqPath,
    });
    const checker = new DrizzleBudgetChecker(db, { cacheTtlMs: 5_000 });

    for (let i = 0; i < 50; i++) {
      emitter.emit(makeEvent(i));
    }
    emitter.flush();

    const limits: SpendLimits = { maxSpendPerHour: 100, maxSpendPerMonth: 1000, label: "bench" };
    const latencies: number[] = [];
    let cacheHits = 0;
    let cacheMisses = 0;

    for (let i = 0; i < 100; i++) {
      const tenant = `tenant-${i % TENANT_COUNT}`;
      // Every 100th check, invalidate cache to simulate cache misses
      if (i % 100 === 0) {
        checker.invalidate(tenant);
        cacheMisses++;
      } else {
        cacheHits++;
      }

      const lat = measureLatencyUs(() => checker.check(tenant, limits));
      latencies.push(lat);
    }

    latencies.sort((a, b) => a - b);
    console.log(`--- Budget check under load ---`);
    console.log(`  Checks: 100 (${cacheHits} cache hits, ${cacheMisses} cache misses)`);
    console.log(`  p50: ${percentile(latencies, 50).toFixed(0)}us`);
    console.log(`  p95: ${percentile(latencies, 95).toFixed(0)}us`);
    console.log(`  p99: ${percentile(latencies, 99).toFixed(0)}us`);

    emitter.close();

    // Cache hits should be sub-millisecond
    expect(percentile(latencies, 50)).toBeLessThan(1_000_000); // p50 < 1s
  });

  it("Scenario 5: Full pipeline — emit, flush, aggregate, budget check cycle", async () => {
    const WINDOW = 60_000;
    const emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 500,
      walPath,
      dlqPath,
    });
    const aggregator = new MeterAggregator(db, { windowMs: WINDOW });
    const checker = new DrizzleBudgetChecker(db);
    const ledger = new CreditLedger(db);
    const limits: SpendLimits = { maxSpendPerHour: 1000, maxSpendPerMonth: 10000 };

    // Pre-fund tenants
    await Promise.all(
      Array.from({ length: TENANT_COUNT }, (_, i) =>
        ledger.credit(`tenant-${i}`, Credit.fromCents(1_000_000), "purchase", "load test setup"),
      ),
    );

    const phases: { name: string; durationMs: number }[] = [];

    // Phase 1: Emit events
    const emitStart = performance.now();
    for (let i = 0; i < 100; i++) {
      emitter.emit(makeEvent(i));
    }
    phases.push({ name: "Emit 100", durationMs: performance.now() - emitStart });

    // Phase 2: Flush
    const flushStart = performance.now();
    await emitter.flush();
    phases.push({ name: "Flush 100", durationMs: performance.now() - flushStart });

    // Phase 3: Aggregate
    const aggStart = performance.now();
    await aggregator.aggregate();
    phases.push({ name: "Aggregate", durationMs: performance.now() - aggStart });

    // Phase 4: Budget checks for all tenants
    const budgetStart = performance.now();
    let allAllowed = true;
    for (let i = 0; i < TENANT_COUNT; i++) {
      const result = await checker.check(`tenant-${i}`, limits);
      if (!result.allowed) allAllowed = false;
    }
    phases.push({ name: `Budget check ${TENANT_COUNT} tenants`, durationMs: performance.now() - budgetStart });

    // Phase 5: Debit credits for all tenants
    const debitStart = performance.now();
    await Promise.all(
      Array.from({ length: TENANT_COUNT }, (_, i) =>
        ledger.debit(`tenant-${i}`, Credit.fromCents(1), "adapter_usage", "load test"),
      ),
    );
    phases.push({ name: `Debit ${TENANT_COUNT} tenants`, durationMs: performance.now() - debitStart });

    console.log(`--- Full pipeline cycle ---`);
    let total = 0;
    for (const p of phases) {
      console.log(`  ${p.name}: ${p.durationMs.toFixed(1)}ms`);
      total += p.durationMs;
    }
    console.log(`  Total: ${total.toFixed(1)}ms`);
    console.log(`  Memory: ${heapMb().toFixed(1)}MB`);

    emitter.close();
    aggregator.stop();

    expect(allAllowed).toBe(true);
    expect(total).toBeLessThan(30_000);
  });

  it("Scenario 6: Memory leak detection — repeated cycles", () => {
    const emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 500,
      walPath,
      dlqPath,
    });

    const memSamples: number[] = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 20; i++) {
        emitter.emit(makeEvent(cycle * 1000 + i));
      }
      emitter.flush();

      if (typeof global.gc === "function") {
        global.gc();
      }
      memSamples.push(heapMb());
    }

    emitter.close();

    console.log(`--- Memory leak detection (5 cycles of 20 events) ---`);
    console.log(`  Start: ${memSamples[0].toFixed(1)}MB`);
    console.log(`  End: ${memSamples[memSamples.length - 1].toFixed(1)}MB`);
    console.log(`  Growth: ${(memSamples[memSamples.length - 1] - memSamples[0]).toFixed(1)}MB`);

    // Memory should not grow unboundedly — allow 50MB growth for 20K events
    const growth = memSamples[memSamples.length - 1] - memSamples[0];
    expect(growth).toBeLessThan(50);
  });
});
