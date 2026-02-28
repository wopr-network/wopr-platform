import { unlinkSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, bench, describe } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { Credit } from "../credit.js";
import { MeterAggregator } from "./aggregator.js";
import { MeterEmitter } from "./emitter.js";
import type { MeterEvent } from "./types.js";

function makeEvent(i: number): MeterEvent {
  return {
    tenant: `tenant-${i % 100}`,
    cost: Credit.fromDollars(0.001 * (i % 10)),
    charge: Credit.fromDollars(0.002 * (i % 10)),
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
  let db: DrizzleDb;
  let pool: PGlite;
  let emitter: MeterEmitter;
  const walPath = `/tmp/wopr-bench-wal-${process.pid}.jsonl`;
  const dlqPath = `/tmp/wopr-bench-dlq-${process.pid}.jsonl`;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    emitter = new MeterEmitter(db, {
      flushIntervalMs: 60_000,
      batchSize: 1000,
      walPath,
      dlqPath,
    });
  });

  afterEach(async () => {
    emitter.close();
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
    async () => {
      for (let i = 0; i < 100; i++) {
        emitter.emit(makeEvent(eventCounter++));
      }
      await emitter.flush();
    },
    { iterations: 100 },
  );

  bench(
    "emit + flush batch of 1000",
    async () => {
      for (let i = 0; i < 1000; i++) {
        emitter.emit(makeEvent(eventCounter++));
      }
      await emitter.flush();
    },
    { iterations: 50 },
  );
});

describe("MeterAggregator throughput", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let emitter: MeterEmitter;
  let aggregator: MeterAggregator;
  const walPath = `/tmp/wopr-bench-agg-wal-${process.pid}.jsonl`;
  const dlqPath = `/tmp/wopr-bench-agg-dlq-${process.pid}.jsonl`;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, walPath, dlqPath });
    aggregator = new MeterAggregator(db, { windowMs: 60_000 });
  });

  afterEach(async () => {
    aggregator.stop();
    emitter.close();
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

  bench(
    "aggregate 10K events",
    async () => {
      await aggregator.aggregate();
    },
    { iterations: 10 },
  );
});
