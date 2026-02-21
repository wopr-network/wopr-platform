/**
 * Tests for CreditLedger — including the allowNegative debit parameter (WOP-821).
 */

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { CreditLedger, InsufficientBalanceError } from "./credit-ledger.js";

function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT UNIQUE,
      funding_source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

describe("CreditLedger.debit with allowNegative", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let ledger: CreditLedger;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    ledger = new CreditLedger(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("debit with allowNegative=false (default) throws InsufficientBalanceError when balance insufficient", () => {
    ledger.credit("t1", 5, "purchase", "setup");
    expect(() => ledger.debit("t1", 10, "adapter_usage", "test")).toThrow(InsufficientBalanceError);
  });

  it("debit with allowNegative=true allows negative balance", () => {
    ledger.credit("t1", 5, "purchase", "setup");
    const txn = ledger.debit("t1", 10, "adapter_usage", "test", undefined, true);
    expect(txn).toBeDefined();
    expect(ledger.balance("t1")).toBe(-5);
  });

  it("debit with allowNegative=true records correct transaction with negative amountCents and negative balanceAfterCents", () => {
    ledger.credit("t1", 5, "purchase", "setup");
    const txn = ledger.debit("t1", 10, "adapter_usage", "test", undefined, true);
    expect(txn.amountCents).toBe(-10);
    expect(txn.balanceAfterCents).toBe(-5);
  });
});
