import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, bench, describe } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleBudgetChecker, type SpendLimits } from "./budget-checker.js";

const limits: SpendLimits = {
  maxSpendPerHour: 10.0,
  maxSpendPerMonth: 100.0,
  label: "bench",
};

let db: DrizzleDb;
let pool: PGlite;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("BudgetChecker throughput", () => {
  let checker: DrizzleBudgetChecker;

  beforeAll(async () => {
    await truncateAllTables(pool);
    checker = new DrizzleBudgetChecker(db, { cacheTtlMs: 30_000, cacheMaxSize: 1000 });
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
