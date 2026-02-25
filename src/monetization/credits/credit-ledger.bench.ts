import { afterEach, beforeEach, bench, describe } from "vitest";
import { createTestDb } from "../../test/db.js";
import { CreditLedger } from "./credit-ledger.js";

describe("CreditLedger throughput", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let ledger: CreditLedger;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    ledger = new CreditLedger(db);

    // Pre-fund 100 tenants with large balances
    for (let i = 0; i < 100; i++) {
      ledger.credit(`tenant-${i}`, 1_000_000, "purchase", "bench setup");
    }
  });

  afterEach(() => {
    sqlite.close();
  });

  let creditIdx = 0;
  let debitIdx = 0;

  bench(
    "credit operation",
    () => {
      const tenant = `tenant-${creditIdx++ % 100}`;
      ledger.credit(tenant, 100, "purchase", "bench");
    },
    { iterations: 10_000 },
  );

  bench(
    "debit operation",
    () => {
      const tenant = `tenant-${debitIdx++ % 100}`;
      ledger.debit(tenant, 1, "adapter_usage", "bench");
    },
    { iterations: 10_000 },
  );

  bench(
    "balance query",
    () => {
      const tenant = `tenant-${debitIdx++ % 100}`;
      ledger.balance(tenant);
    },
    { iterations: 50_000 },
  );
});
