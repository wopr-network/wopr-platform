import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { CreditLedger } from "./credit-ledger.js";
import { runRuntimeDeductions } from "./runtime-cron.js";

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

describe("runtime cron with storage tiers", () => {
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

  it("debits base cost plus storage surcharge for pro tier", async () => {
    ledger.credit("t1", 1000, "purchase");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      getStorageTierCosts: () => 8,
    });
    expect(result.processed).toBe(1);
    const balance = ledger.balance("t1");
    // 1000 - 17 (base) - 8 (pro storage surcharge) = 975
    expect(balance).toBe(975);
  });

  it("debits only base cost for standard storage tier (zero surcharge)", async () => {
    ledger.credit("t1", 1000, "purchase");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      getStorageTierCosts: () => 0,
    });
    expect(result.processed).toBe(1);
    expect(ledger.balance("t1")).toBe(983); // 1000 - 17
  });

  it("skips storage surcharge when callback not provided (backward compat)", async () => {
    ledger.credit("t1", 1000, "purchase");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
    });
    expect(result.processed).toBe(1);
    expect(ledger.balance("t1")).toBe(983); // 1000 - 17
  });

  it("suspends tenant when storage surcharge exhausts remaining balance", async () => {
    ledger.credit("t1", 20, "purchase"); // Only 20 cents
    const suspended: string[] = [];
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      getStorageTierCosts: () => 8,
      onSuspend: (tenantId) => {
        suspended.push(tenantId);
      },
    });
    // 20 - 17 = 3 remaining, then 8 surcharge > 3, so partial debit + suspend
    expect(result.processed).toBe(1);
    expect(result.suspended).toContain("t1");
    expect(ledger.balance("t1")).toBe(0);
  });
});
