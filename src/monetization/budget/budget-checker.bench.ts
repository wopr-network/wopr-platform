import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, bench, describe } from "vitest";
import { createTestDb } from "../../test/db.js";
import { MeterEmitter } from "../metering/emitter.js";
import { DrizzleBudgetChecker, type SpendLimits } from "./budget-checker.js";

const limits: SpendLimits = {
  maxSpendPerHour: 10.0,
  maxSpendPerMonth: 100.0,
  label: "bench",
};

describe("BudgetChecker throughput", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let checker: DrizzleBudgetChecker;
  const walPath = `/tmp/wopr-bench-budget-wal-${process.pid}.jsonl`;
  const dlqPath = `/tmp/wopr-bench-budget-dlq-${process.pid}.jsonl`;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    checker = new DrizzleBudgetChecker(db, { cacheTtlMs: 30_000, cacheMaxSize: 1000 });

    // Pre-populate meter events for 100 tenants
    const emitter = new MeterEmitter(db, { flushIntervalMs: 60_000, walPath, dlqPath });
    for (let i = 0; i < 1000; i++) {
      emitter.emit({
        tenant: `tenant-${i % 100}`,
        cost: 0.001,
        charge: 0.002,
        capability: "chat",
        provider: "openai",
        timestamp: Date.now() - 60_000 + i,
      });
    }
    emitter.flush();
    emitter.close();
  });

  afterEach(() => {
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

  let tenantIdx = 0;

  bench(
    "budget check (cache hit)",
    () => {
      // First call populates cache, subsequent calls hit cache
      checker.check("tenant-0", limits);
    },
    { iterations: 100_000 },
  );

  bench(
    "budget check (cache miss — cold path)",
    () => {
      // Invalidate before each check to force DB query
      const tenant = `tenant-${tenantIdx++ % 100}`;
      checker.invalidate(tenant);
      checker.check(tenant, limits);
    },
    { iterations: 10_000 },
  );
});
