import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/index.js";
import { CreditLedger } from "./credit-ledger.js";

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
      attributed_user_id TEXT,
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

describe("DrizzleCreditLedger.memberUsage", () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof createDb>;
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

  it("should aggregate debit totals per attributed user", () => {
    ledger.credit("org-1", 10000, "purchase", "Seed");
    ledger.debit("org-1", 100, "adapter_usage", "Chat", undefined, false, "user-a");
    ledger.debit("org-1", 200, "adapter_usage", "Chat", undefined, false, "user-a");
    ledger.debit("org-1", 300, "adapter_usage", "Chat", undefined, false, "user-b");

    const result = ledger.memberUsage("org-1");
    expect(result).toHaveLength(2);

    const userA = result.find((r) => r.userId === "user-a");
    expect(userA?.totalDebitCents).toBe(300);
    expect(userA?.transactionCount).toBe(2);

    const userB = result.find((r) => r.userId === "user-b");
    expect(userB?.totalDebitCents).toBe(300);
    expect(userB?.transactionCount).toBe(1);
  });

  it("should exclude transactions with null attributedUserId", () => {
    ledger.credit("org-1", 10000, "purchase", "Seed");
    ledger.debit("org-1", 100, "bot_runtime", "Cron"); // no attributedUserId
    ledger.debit("org-1", 200, "adapter_usage", "Chat", undefined, false, "user-a");

    const result = ledger.memberUsage("org-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-a");
  });

  it("should return empty array when no attributed debits exist", () => {
    const result = ledger.memberUsage("org-1");
    expect(result).toEqual([]);
  });
});
