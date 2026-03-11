/**
 * Additional CreditLedger tests — concurrent debit safety.
 * memberUsage() tests live in member-usage.test.ts.
 */
import type { PGlite } from "@electric-sql/pglite";
import { Credit, CreditLedger, InsufficientBalanceError } from "@wopr-network/platform-core/credits";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

describe("CreditLedger concurrent debit safety", () => {
  let ledger: CreditLedger;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    ledger = new CreditLedger(db);
  });

  it("concurrent debits do not overdraw — at least one should fail with InsufficientBalanceError", async () => {
    // Fund with exactly 100 cents
    await ledger.credit("t1", Credit.fromCents(100), "purchase");

    // Fire two 100-cent debits concurrently — only one can succeed
    const results = await Promise.allSettled([
      ledger.debit("t1", Credit.fromCents(100), "bot_runtime", "debit-1"),
      ledger.debit("t1", Credit.fromCents(100), "bot_runtime", "debit-2"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one succeeds, one fails (PGlite serializes transactions so this is deterministic)
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(InsufficientBalanceError);

    // Final balance must be exactly 0, not negative
    const bal = await ledger.balance("t1");
    expect(bal.toCents()).toBe(0);
  });
});
