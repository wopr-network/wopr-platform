import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, bench, describe } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { DrizzleBudgetChecker, type SpendLimits } from "./budget-checker.js";

const limits: SpendLimits = {
  maxSpendPerHour: 10.0,
  maxSpendPerMonth: 100.0,
  label: "bench",
};

describe("BudgetChecker throughput", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let checker: DrizzleBudgetChecker;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    checker = new DrizzleBudgetChecker(db, { cacheTtlMs: 30_000, cacheMaxSize: 1000 });
  });

  afterEach(async () => {
    await pool.close();
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
