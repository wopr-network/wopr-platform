import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, bench, describe } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger } from "./credit-ledger.js";

describe("CreditLedger throughput", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  let creditIdx = 0;
  let debitIdx = 0;

  bench(
    "credit operation",
    async () => {
      const tenant = `tenant-${creditIdx++ % 100}`;
      await ledger.credit(tenant, Credit.fromCents(100), "purchase", "bench");
    },
    { iterations: 1_000 },
  );

  bench(
    "debit operation",
    async () => {
      const tenant = `tenant-${debitIdx++ % 100}`;
      await ledger.debit(tenant, Credit.fromCents(1), "adapter_usage", "bench");
    },
    { iterations: 1_000 },
  );

  bench(
    "balance query",
    async () => {
      const tenant = `tenant-${debitIdx++ % 100}`;
      await ledger.balance(tenant);
    },
    { iterations: 5_000 },
  );
});
