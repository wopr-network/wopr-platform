import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { MeterDLQ } from "./dlq.js";
import { DrizzleMeterEmitter } from "./emitter.js";
import type { MeterEvent } from "./types.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `emitter-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(overrides: Partial<MeterEvent> = {}): MeterEvent {
  return {
    tenant: "t1",
    cost: Credit.fromCents(1),
    charge: Credit.fromCents(2),
    capability: "llm",
    provider: "openai",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("DrizzleMeterEmitter — happy path", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let emitter: DrizzleMeterEmitter;
  let tempDir: string;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    await truncateAllTables(pool);
    tempDir = makeTempDir();
    emitter = new DrizzleMeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 100,
      walPath: join(tempDir, "wal.jsonl"),
      dlqPath: join(tempDir, "dlq.jsonl"),
      maxRetries: 3,
    });
    await emitter.ready;
  });

  afterEach(async () => {
    // Flush remaining events before close() to drain the buffer synchronously
    await emitter.flush();
    emitter.close();
    await pool.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("writes a meter event to the database after flush", async () => {
    emitter.emit(makeEvent({ tenant: "t1", capability: "voice" }));
    expect(emitter.pending).toBe(1);

    const flushed = await emitter.flush();
    expect(flushed).toBe(1);
    expect(emitter.pending).toBe(0);

    const rows = await emitter.queryEvents("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant).toBe("t1");
    expect(rows[0].capability).toBe("voice");
    expect(rows[0].cost).toBe(Credit.fromCents(1).toRaw());
    expect(rows[0].charge).toBe(Credit.fromCents(2).toRaw());
  });

  it("persists multiple events in one flush", async () => {
    emitter.emit(makeEvent({ tenant: "t1" }));
    emitter.emit(makeEvent({ tenant: "t1" }));
    emitter.emit(makeEvent({ tenant: "t2" }));

    const flushed = await emitter.flush();
    expect(flushed).toBe(3);

    const t1Rows = await emitter.queryEvents("t1");
    expect(t1Rows).toHaveLength(2);

    const t2Rows = await emitter.queryEvents("t2");
    expect(t2Rows).toHaveLength(1);
  });

  it("flush returns 0 when buffer is empty", async () => {
    expect(await emitter.flush()).toBe(0);
  });

  it("silently drops events emitted after close", async () => {
    emitter.close();
    emitter.emit(makeEvent());
    expect(emitter.pending).toBe(0);
  });

  it("persists sessionId, duration, usage, tier, and metadata", async () => {
    emitter.emit(
      makeEvent({
        sessionId: "sess-1",
        duration: 5000,
        usage: { units: 100, unitType: "tokens" },
        tier: "wopr",
        metadata: { model: "gpt-4" },
      }),
    );
    await emitter.flush();

    const rows = await emitter.queryEvents("t1");
    expect(rows[0].session_id).toBe("sess-1");
    expect(rows[0].duration).toBe(5000);
    expect(rows[0].usage_units).toBe(100);
    expect(rows[0].usage_unit_type).toBe("tokens");
    expect(rows[0].tier).toBe("wopr");
    expect(JSON.parse(rows[0].metadata!)).toEqual({ model: "gpt-4" });
  });
});

describe("DrizzleMeterEmitter — DLQ failure paths", () => {
  it("moves events to DLQ after maxRetries failures", async () => {
    const { db: failDb, pool: failPool } = await createTestDb();
    const failTempDir = makeTempDir();
    const dlqPath = join(failTempDir, "dlq.jsonl");

    const em = new DrizzleMeterEmitter(failDb, {
      flushIntervalMs: 60_000,
      walPath: join(failTempDir, "wal.jsonl"),
      dlqPath,
      maxRetries: 1,
    });
    await em.ready;

    em.emit(makeEvent());

    // Drop the table so flush fails
    await failPool.query("DROP TABLE meter_events CASCADE");
    await em.flush();

    // maxRetries=1: first failure hits the limit => DLQ
    const dlq = new MeterDLQ(dlqPath);
    expect(dlq.count()).toBe(1);
    expect(em.pending).toBe(0);

    em.close();
    await failPool.close();
    try {
      rmSync(failTempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("retries failed events before moving to DLQ", async () => {
    const { db: failDb, pool: failPool } = await createTestDb();
    const failTempDir = makeTempDir();
    const dlqPath = join(failTempDir, "dlq.jsonl");

    const em = new DrizzleMeterEmitter(failDb, {
      flushIntervalMs: 60_000,
      walPath: join(failTempDir, "wal.jsonl"),
      dlqPath,
      maxRetries: 2,
    });
    await em.ready;

    em.emit(makeEvent());

    // First flush fails
    await failPool.query("DROP TABLE meter_events CASCADE");
    await em.flush();

    // After first failure (maxRetries=2): still in buffer for retry
    expect(em.pending).toBe(1);

    // DLQ should be empty — not yet reached maxRetries
    const dlq = new MeterDLQ(dlqPath);
    expect(dlq.count()).toBe(0);

    // Clear the buffer before close to avoid a DLQ write race during cleanup
    em["buffer"] = [];
    em.close();
    await failPool.close();
    try {
      rmSync(failTempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
