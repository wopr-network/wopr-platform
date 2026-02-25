import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, bench, describe } from "vitest";
import { createTestDb } from "../../test/db.js";
import { MeterAggregator } from "./aggregator.js";
import { MeterEmitter } from "./emitter.js";
import type { MeterEvent } from "./types.js";

function makeEvent(i: number): MeterEvent {
  return {
    tenant: `tenant-${i % 100}`,
    cost: 0.001 * (i % 10),
    charge: 0.002 * (i % 10),
    capability: ["chat", "voice", "embeddings", "tts", "stt"][i % 5],
    provider: ["openai", "deepgram", "elevenlabs", "openrouter"][i % 4],
    timestamp: Date.now() - 120_000 + i,
    sessionId: `session-${i % 50}`,
    duration: i % 2 === 0 ? 1000 + i : undefined,
    usage: i % 3 === 0 ? { units: 100 + i, unitType: "tokens" } : undefined,
    tier: (["branded", "wopr", "byok"] as const)[i % 3],
  };
}

describe("MeterEmitter throughput", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let emitter: MeterEmitter;
  const walPath = `/tmp/wopr-bench-wal-${process.pid}.jsonl`;
  const dlqPath = `/tmp/wopr-bench-dlq-${process.pid}.jsonl`;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 1000,
      walPath,
      dlqPath,
    });
  });

  afterEach(() => {
    emitter.close();
    sqlite.close();
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

  let eventCounter = 0;

  bench(
    "emit single event (includes WAL write)",
    () => {
      emitter.emit(makeEvent(eventCounter++));
    },
    { iterations: 10_000 },
  );

  bench(
    "emit + flush batch of 100",
    () => {
      for (let i = 0; i < 100; i++) {
        emitter.emit(makeEvent(eventCounter++));
      }
      emitter.flush();
    },
    { iterations: 100 },
  );

  bench(
    "emit + flush batch of 1000",
    () => {
      for (let i = 0; i < 1000; i++) {
        emitter.emit(makeEvent(eventCounter++));
      }
      emitter.flush();
    },
    { iterations: 50 },
  );
});

describe("MeterAggregator throughput", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let emitter: MeterEmitter;
  let aggregator: MeterAggregator;
  const walPath = `/tmp/wopr-bench-agg-wal-${process.pid}.jsonl`;
  const dlqPath = `/tmp/wopr-bench-agg-dlq-${process.pid}.jsonl`;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, walPath, dlqPath });
    aggregator = new MeterAggregator(db, { windowMs: 60_000 });

    // Pre-populate: 10K events across 10 tenants in a past window
    for (let i = 0; i < 10_000; i++) {
      emitter.emit(makeEvent(i));
    }
    emitter.flush();
  });

  afterEach(() => {
    aggregator.stop();
    emitter.close();
    sqlite.close();
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

  bench(
    "aggregate 10K events",
    () => {
      aggregator.aggregate();
    },
    { iterations: 10 },
  );
});
