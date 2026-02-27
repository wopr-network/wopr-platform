import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { creditBalances, creditTransactions } from "../../db/schema/credits.js";
import { createTestDb } from "../../test/db.js";
import { CreditLedger } from "./credit-ledger.js";
import { DrizzleCreditTransactionRepository } from "./credit-transaction-repository.js";
import { type DividendCronConfig, runDividendCron } from "./dividend-cron.js";

async function insertPurchase(
  db: DrizzleDb,
  tenantId: string,
  amountCredits: number,
  createdAt: string,
): Promise<void> {
  const id = `test-${tenantId}-${Date.now()}-${Math.random()}`;
  await db.insert(creditTransactions).values({
    id,
    tenantId,
    amountCredits,
    balanceAfterCredits: amountCredits,
    type: "purchase",
    createdAt,
  });
  // Upsert credit_balances
  const existing = await db
    .select()
    .from(creditBalances)
    .where((await import("drizzle-orm")).eq(creditBalances.tenantId, tenantId));
  if (existing.length > 0) {
    await db
      .update(creditBalances)
      .set({ balanceCredits: existing[0].balanceCredits + amountCredits })
      .where((await import("drizzle-orm")).eq(creditBalances.tenantId, tenantId));
  } else {
    await db.insert(creditBalances).values({ tenantId, balanceCredits: amountCredits });
  }
}

describe("runDividendCron", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;
  let creditTransactionRepo: DrizzleCreditTransactionRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
    creditTransactionRepo = new DrizzleCreditTransactionRepository(db);
  });

  afterEach(async () => {
    await pool.close();
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

  it("distributes dividend to eligible tenants", async () => {
    await insertPurchase(db, "t1", 1000, "2026-02-20 12:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.distributed).toBe(1);
    expect(result.poolCredits).toBe(1000);
    expect(result.perUserCredits).toBe(1000);
    expect(result.activeCount).toBe(1);
  });

  it("is idempotent — skips if already ran for the date", async () => {
    await insertPurchase(db, "t1", 1000, "2026-02-20 12:00:00");

    const result1 = await runDividendCron(makeConfig());
    expect(result1.distributed).toBe(1);
    expect(result1.skippedAlreadyRun).toBe(false);

    const balanceAfterFirst = await ledger.balance("t1");

    const result2 = await runDividendCron(makeConfig());
    expect(result2.skippedAlreadyRun).toBe(true);
    expect(result2.distributed).toBe(0);

    expect(await ledger.balance("t1")).toBe(balanceAfterFirst);
  });

  it("handles floor rounding — remainder is not distributed", async () => {
    await insertPurchase(db, "t1", 50, "2026-02-20 12:00:00");
    await insertPurchase(db, "t2", 30, "2026-02-20 12:00:00");
    await insertPurchase(db, "t3", 20, "2026-02-20 12:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.poolCredits).toBe(100);
    expect(result.activeCount).toBe(3);
    expect(result.perUserCredits).toBe(33);
    expect(result.distributed).toBe(3);
  });

  it("skips distribution when pool is zero", async () => {
    // Tenant purchased within 7 days but NOT on target date -> pool = 0
    await insertPurchase(db, "t1", 500, "2026-02-18 12:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.poolCredits).toBe(0);
    expect(result.activeCount).toBe(1);
    expect(result.perUserCredits).toBe(0);
    expect(result.distributed).toBe(0);
  });

  it("skips distribution when per-user share rounds to zero", async () => {
    await insertPurchase(db, "t1", 1, "2026-02-20 12:00:00");
    await insertPurchase(db, "t2", 500, "2026-02-18 12:00:00");
    await insertPurchase(db, "t3", 500, "2026-02-17 12:00:00");

    const result = await runDividendCron(makeConfig({ matchRate: 1.0 }));

    expect(result.poolCredits).toBe(1);
    expect(result.activeCount).toBe(3);
    expect(result.perUserCredits).toBe(0);
    expect(result.distributed).toBe(0);
  });

  it("records transactions with correct type and referenceId", async () => {
    await insertPurchase(db, "t1", 1000, "2026-02-20 12:00:00");

    await runDividendCron(makeConfig());

    const history = await ledger.history("t1", { type: "community_dividend" });
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("community_dividend");
    expect(history[0].referenceId).toBe("dividend:2026-02-20:t1");
    expect(history[0].amountCredits).toBe(1000);
    expect(history[0].description).toContain("Community dividend");
  });

  it("collects errors without stopping distribution to other tenants", async () => {
    await insertPurchase(db, "t1", 500, "2026-02-20 12:00:00");
    await insertPurchase(db, "t2", 500, "2026-02-20 12:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.distributed).toBe(2);
    expect(result.errors).toEqual([]);
  });
});
