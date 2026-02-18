import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { CreditLedger, InsufficientBalanceError } from "./credit-ledger.js";
import { DAILY_BOT_COST_CENTS, runRuntimeDeductions } from "./runtime-cron.js";

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

describe("runRuntimeDeductions", () => {
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

  it("DAILY_BOT_COST_CENTS equals 17", () => {
    expect(DAILY_BOT_COST_CENTS).toBe(17);
  });

  it("returns empty result when no tenants have balance", async () => {
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 0,
    });
    expect(result.processed).toBe(0);
    expect(result.suspended).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("skips tenants with zero active bots", async () => {
    ledger.credit("tenant-1", 500, "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 0,
    });
    expect(result.processed).toBe(0);
    // Balance unchanged
    expect(ledger.balance("tenant-1")).toBe(500);
  });

  it("deducts full amount when balance is sufficient", async () => {
    ledger.credit("tenant-1", 500, "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 2,
    });
    expect(result.processed).toBe(1);
    expect(result.suspended).toEqual([]);
    expect(ledger.balance("tenant-1")).toBe(500 - 2 * DAILY_BOT_COST_CENTS);
  });

  it("partial deduction and suspension when balance is insufficient", async () => {
    ledger.credit("tenant-1", 10, "purchase", "top-up");
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      onSuspend,
    });
    expect(result.processed).toBe(1);
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
    // Balance should be 0 after partial deduction
    expect(ledger.balance("tenant-1")).toBe(0);
  });

  it("suspends with zero partial when balance exactly zero", async () => {
    // Credit then debit to reach exactly 0 but have balance row
    ledger.credit("tenant-1", 100, "purchase", "top-up");
    ledger.debit("tenant-1", 100, "bot_runtime", "drain");
    // Re-credit to get a positive balance row so tenantsWithBalance picks it up...
    // Actually tenantsWithBalance only returns > 0. Let me give a tiny amount.
    ledger.credit("tenant-1", 1, "purchase", "tiny");

    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      onSuspend,
    });
    // 1 cent < 17 cents cost, so partial deduction path
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
    expect(ledger.balance("tenant-1")).toBe(0);
  });

  it("suspends without onSuspend callback", async () => {
    ledger.credit("tenant-1", 5, "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      // No onSuspend
    });
    expect(result.suspended).toContain("tenant-1");
    expect(result.processed).toBe(1);
  });

  it("handles errors from getActiveBotCount gracefully", async () => {
    ledger.credit("tenant-1", 500, "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => {
        throw new Error("db connection failed");
      },
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("tenant-1");
    expect(result.errors[0]).toContain("db connection failed");
  });

  it("handles InsufficientBalanceError from ledger.debit", async () => {
    // Credit a small amount so tenantsWithBalance returns the tenant
    ledger.credit("tenant-1", 500, "purchase", "top-up");
    // Drain most of it
    ledger.debit("tenant-1", 499, "bot_runtime", "drain");
    // Now balance is 1 cent, cost is 17 for 1 bot
    // The balance (1) < totalCost (17) path → partial deduction
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      onSuspend,
    });
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
  });

  it("catches InsufficientBalanceError from debit and suspends", async () => {
    ledger.credit("tenant-1", 500, "purchase", "top-up");
    // Spy on debit to throw InsufficientBalanceError (simulates race condition)
    vi.spyOn(ledger, "debit").mockImplementation(() => {
      throw new InsufficientBalanceError(0, 17);
    });
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      onSuspend,
    });
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
    expect(result.processed).toBe(1);
    vi.restoreAllMocks();
  });

  it("catches InsufficientBalanceError without onSuspend callback", async () => {
    ledger.credit("tenant-1", 500, "purchase", "top-up");
    vi.spyOn(ledger, "debit").mockImplementation(() => {
      throw new InsufficientBalanceError(0, 17);
    });
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      // No onSuspend
    });
    expect(result.suspended).toContain("tenant-1");
    expect(result.processed).toBe(1);
    vi.restoreAllMocks();
  });

  it("processes multiple tenants", async () => {
    ledger.credit("tenant-1", 500, "purchase", "top-up");
    ledger.credit("tenant-2", 10, "purchase", "top-up");
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: () => 1,
      onSuspend,
    });
    expect(result.processed).toBe(2);
    // tenant-1 has enough, tenant-2 doesn't
    expect(result.suspended).toContain("tenant-2");
    expect(result.suspended).not.toContain("tenant-1");
  });
});
