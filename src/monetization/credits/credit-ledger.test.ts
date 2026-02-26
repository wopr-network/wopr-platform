/**
 * Tests for CreditLedger — including the allowNegative debit parameter (WOP-821).
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { CreditLedger, InsufficientBalanceError } from "./credit-ledger.js";

describe("CreditLedger.debit with allowNegative", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("debit with allowNegative=false (default) throws InsufficientBalanceError when balance insufficient", async () => {
    await ledger.credit("t1", 5, "purchase", "setup");
    await expect(ledger.debit("t1", 10, "adapter_usage", "test")).rejects.toThrow(InsufficientBalanceError);
  });

  it("debit with allowNegative=true allows negative balance", async () => {
    await ledger.credit("t1", 5, "purchase", "setup");
    const txn = await ledger.debit("t1", 10, "adapter_usage", "test", undefined, true);
    expect(txn).toBeDefined();
    expect(await ledger.balance("t1")).toBe(-5);
  });

  it("debit with allowNegative=true records correct transaction with negative amountCents and negative balanceAfterCents", async () => {
    await ledger.credit("t1", 5, "purchase", "setup");
    const txn = await ledger.debit("t1", 10, "adapter_usage", "test", undefined, true);
    expect(txn.amountCents).toBe(-10);
    expect(txn.balanceAfterCents).toBe(-5);
  });
});
