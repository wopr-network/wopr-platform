import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/index.js";
import { CreditLedger } from "./credit-ledger.js";
import { DrizzleCreditTransactionRepository } from "./credit-transaction-repository.js";
import { type DividendCronConfig, runDividendCron } from "./dividend-cron.js";

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

/** Insert a purchase transaction with a specific created_at timestamp. */
function insertPurchase(
  sqlite: BetterSqlite3.Database,
  tenantId: string,
  amountCents: number,
  createdAt: string,
): void {
  const id = `test-${tenantId}-${Date.now()}-${Math.random()}`;
  sqlite
    .prepare(`
    INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type, created_at)
    VALUES (?, ?, ?, ?, 'purchase', ?)
  `)
    .run(id, tenantId, amountCents, amountCents, createdAt);
  // Also upsert balance so ledger.credit() works correctly for dividend distribution
  const existing = sqlite.prepare(`SELECT balance_cents FROM credit_balances WHERE tenant_id = ?`).get(tenantId) as
    | { balance_cents: number }
    | undefined;
  if (existing) {
    sqlite
      .prepare(`UPDATE credit_balances SET balance_cents = balance_cents + ? WHERE tenant_id = ?`)
      .run(amountCents, tenantId);
  } else {
    sqlite.prepare(`INSERT INTO credit_balances (tenant_id, balance_cents) VALUES (?, ?)`).run(tenantId, amountCents);
  }
}

describe("runDividendCron", () => {
  let sqlite: BetterSqlite3.Database;
  let ledger: CreditLedger;
  let creditTransactionRepo: DrizzleCreditTransactionRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    ledger = new CreditLedger(db);
    creditTransactionRepo = new DrizzleCreditTransactionRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function makeConfig(overrides?: Partial<DividendCronConfig>): DividendCronConfig {
    return {
      creditTransactionRepo,
      ledger,
      matchRate: 1.0,
      targetDate: "2026-02-20",
      ...overrides,
    };
  }

  it("returns zero result when no purchases exist", async () => {
    const result = await runDividendCron(makeConfig());
    expect(result.poolCents).toBe(0);
    expect(result.activeCount).toBe(0);
    expect(result.perUserCents).toBe(0);
    expect(result.distributed).toBe(0);
    expect(result.skippedAlreadyRun).toBe(false);
  });

  it("distributes equal shares to active tenants", async () => {
    // Two tenants purchased yesterday (2026-02-20)
    insertPurchase(sqlite, "t1", 1000, "2026-02-20 12:00:00");
    insertPurchase(sqlite, "t2", 500, "2026-02-20 15:00:00");
    // t1 also purchased 3 days ago (within 7-day window)
    insertPurchase(sqlite, "t1", 200, "2026-02-18 10:00:00");

    const result = await runDividendCron(makeConfig());

    // Pool = (1000 + 500) * 1.0 = 1500 cents (only yesterday's purchases)
    expect(result.poolCents).toBe(1500);
    // Both tenants are active (purchased within 7 days)
    expect(result.activeCount).toBe(2);
    // Per user = floor(1500 / 2) = 750
    expect(result.perUserCents).toBe(750);
    expect(result.distributed).toBe(2);

    // Verify balances increased by 750 each
    // t1 had 1200 (1000 + 200), now 1200 + 750 = 1950
    expect(ledger.balance("t1")).toBe(1950);
    // t2 had 500, now 500 + 750 = 1250
    expect(ledger.balance("t2")).toBe(1250);
  });

  it("respects matchRate multiplier", async () => {
    insertPurchase(sqlite, "t1", 1000, "2026-02-20 12:00:00");

    const result = await runDividendCron(makeConfig({ matchRate: 0.5 }));

    // Pool = 1000 * 0.5 = 500
    expect(result.poolCents).toBe(500);
    expect(result.perUserCents).toBe(500);
    expect(result.distributed).toBe(1);
  });

  it("includes tenants who purchased within 7 days but NOT yesterday", async () => {
    // t1 purchased yesterday
    insertPurchase(sqlite, "t1", 1000, "2026-02-20 12:00:00");
    // t2 purchased 5 days ago (within 7-day window) but NOT yesterday
    insertPurchase(sqlite, "t2", 300, "2026-02-15 10:00:00");

    const result = await runDividendCron(makeConfig());

    // Pool = 1000 (only yesterday's purchases)
    expect(result.poolCents).toBe(1000);
    // Both tenants are active
    expect(result.activeCount).toBe(2);
    // Per user = floor(1000 / 2) = 500
    expect(result.perUserCents).toBe(500);
    expect(result.distributed).toBe(2);
  });

  it("excludes tenants whose last purchase was more than 7 days ago", async () => {
    // t1 purchased yesterday
    insertPurchase(sqlite, "t1", 1000, "2026-02-20 12:00:00");
    // t2 purchased 10 days ago (outside 7-day window)
    insertPurchase(sqlite, "t2", 300, "2026-02-10 10:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.poolCents).toBe(1000);
    expect(result.activeCount).toBe(1);
    expect(result.perUserCents).toBe(1000);
    expect(result.distributed).toBe(1);

    // t2 should NOT have received anything — balance unchanged at 300
    expect(ledger.balance("t2")).toBe(300);
  });

  it("is idempotent — second run for same date is a no-op", async () => {
    insertPurchase(sqlite, "t1", 1000, "2026-02-20 12:00:00");

    const result1 = await runDividendCron(makeConfig());
    expect(result1.distributed).toBe(1);
    expect(result1.skippedAlreadyRun).toBe(false);

    const balanceAfterFirst = ledger.balance("t1");

    const result2 = await runDividendCron(makeConfig());
    expect(result2.skippedAlreadyRun).toBe(true);
    expect(result2.distributed).toBe(0);

    // Balance should not have changed
    expect(ledger.balance("t1")).toBe(balanceAfterFirst);
  });

  it("handles floor rounding — remainder is not distributed", async () => {
    // Pool = 100, 3 tenants → floor(100/3) = 33 each, 1 cent remainder
    insertPurchase(sqlite, "t1", 50, "2026-02-20 12:00:00");
    insertPurchase(sqlite, "t2", 30, "2026-02-20 12:00:00");
    insertPurchase(sqlite, "t3", 20, "2026-02-20 12:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.poolCents).toBe(100);
    expect(result.activeCount).toBe(3);
    expect(result.perUserCents).toBe(33); // floor(100/3)
    expect(result.distributed).toBe(3);
  });

  it("skips distribution when pool is zero", async () => {
    // Tenant purchased within 7 days but NOT yesterday → pool = 0
    insertPurchase(sqlite, "t1", 500, "2026-02-18 12:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.poolCents).toBe(0);
    expect(result.activeCount).toBe(1);
    expect(result.perUserCents).toBe(0);
    expect(result.distributed).toBe(0);
  });

  it("skips distribution when per-user share rounds to zero", async () => {
    // Pool = 1 cent, 3 tenants → floor(1/3) = 0
    insertPurchase(sqlite, "t1", 1, "2026-02-20 12:00:00");
    insertPurchase(sqlite, "t2", 500, "2026-02-18 12:00:00");
    insertPurchase(sqlite, "t3", 500, "2026-02-17 12:00:00");

    const result = await runDividendCron(makeConfig({ matchRate: 1.0 }));

    expect(result.poolCents).toBe(1);
    expect(result.activeCount).toBe(3);
    expect(result.perUserCents).toBe(0);
    expect(result.distributed).toBe(0);
  });

  it("records transactions with correct type and referenceId", async () => {
    insertPurchase(sqlite, "t1", 1000, "2026-02-20 12:00:00");

    await runDividendCron(makeConfig());

    const history = ledger.history("t1", { type: "community_dividend" });
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("community_dividend");
    expect(history[0].referenceId).toBe("dividend:2026-02-20:t1");
    expect(history[0].amountCents).toBe(1000);
    expect(history[0].description).toContain("Community dividend");
  });

  it("collects errors without stopping distribution to other tenants", async () => {
    insertPurchase(sqlite, "t1", 500, "2026-02-20 12:00:00");
    insertPurchase(sqlite, "t2", 500, "2026-02-20 12:00:00");

    const result = await runDividendCron(makeConfig());

    // Both should succeed in the normal case
    expect(result.distributed).toBe(2);
    expect(result.errors).toEqual([]);
  });
});
