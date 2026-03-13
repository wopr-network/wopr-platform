import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, truncateAllTables } from "@wopr-network/platform-core/test/db";
import { Credit } from "@wopr-network/platform-core";
import { DrizzleLedger } from "@wopr-network/platform-core";
import { type DividendCronConfig, runDividendCron } from "@wopr-network/platform-core/monetization/credits/dividend-cron";

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

async function insertPurchase(ledger: DrizzleLedger, tenantId: string, amountCents: number, postedAt: string): Promise<void> {
  const amount = Credit.fromCents(amountCents);
  await ledger.post({
    entryType: "purchase",
    tenantId,
    postedAt,
    lines: [
      { accountCode: "1000", amount, side: "debit" },
      { accountCode: `2000:${tenantId}`, amount, side: "credit" },
    ],
  });
}

describe("E2E: dividend cron — community pool distribution", () => {
  const TARGET_DATE = "2026-03-01";

  let pool: PGlite;
  let ledger: DrizzleLedger;

  beforeAll(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    ledger = new DrizzleLedger(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    await ledger.seedSystemAccounts();
  });

  function makeConfig(overrides?: Partial<DividendCronConfig>): DividendCronConfig {
    return {
      ledger,
      matchRate: 1.0,
      targetDate: TARGET_DATE,
      ...overrides,
    };
  }

  it("basic distribution: 3 tenants buy $10 each, each receives $10 dividend", async () => {
    const tenants = ["tenant-a", "tenant-b", "tenant-c"];
    for (const tenantId of tenants) {
      await insertPurchase(ledger, tenantId, 1000, `${TARGET_DATE} 10:00:00`);
    }

    const result = await runDividendCron(makeConfig());

    expect(result.skippedAlreadyRun).toBe(false);
    expect(result.pool.toCents()).toBe(3000);
    expect(result.activeCount).toBe(3);
    expect(result.perUser.toCents()).toBe(1000);
    expect(result.distributed).toBe(3);
    expect(result.errors).toEqual([]);

    for (const tenantId of tenants) {
      const balance = await ledger.balance(tenantId);
      // Balance = original $10 purchase + $10 dividend = $20
      expect(balance.toCents()).toBe(2000);
    }
  });

  it("unequal purchases, equal distribution: pool splits evenly regardless of purchase amount", async () => {
    await insertPurchase(ledger, "tenant-a", 5000, `${TARGET_DATE} 09:00:00`);
    await insertPurchase(ledger, "tenant-b", 1000, `${TARGET_DATE} 11:00:00`);
    // C purchased 3 days before target date — active in 7-day window, contributes $0 to pool
    await insertPurchase(ledger, "tenant-c", 2000, "2026-02-26 08:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.skippedAlreadyRun).toBe(false);
    expect(result.pool.toCents()).toBe(6000);
    expect(result.activeCount).toBe(3);
    expect(result.perUser.toCents()).toBe(2000);
    expect(result.distributed).toBe(3);
    expect(result.errors).toEqual([]);

    expect((await ledger.balance("tenant-a")).toCents()).toBe(5000 + 2000);
    expect((await ledger.balance("tenant-b")).toCents()).toBe(1000 + 2000);
    expect((await ledger.balance("tenant-c")).toCents()).toBe(2000 + 2000);
  });

  it("idempotency: running cron twice for same date skips on second run", async () => {
    await insertPurchase(ledger, "tenant-a", 1000, `${TARGET_DATE} 10:00:00`);
    await insertPurchase(ledger, "tenant-b", 1000, `${TARGET_DATE} 11:00:00`);

    const cfg = makeConfig();

    const first = await runDividendCron(cfg);
    expect(first.skippedAlreadyRun).toBe(false);
    expect(first.distributed).toBe(2);

    const balanceA = await ledger.balance("tenant-a");
    const balanceB = await ledger.balance("tenant-b");

    const second = await runDividendCron(cfg);
    expect(second.skippedAlreadyRun).toBe(true);
    expect(second.distributed).toBe(0);
    expect(second.pool.toCents()).toBe(0);

    expect((await ledger.balance("tenant-a")).toCents()).toBe(balanceA.toCents());
    expect((await ledger.balance("tenant-b")).toCents()).toBe(balanceB.toCents());
  });

  it("zero pool: no purchases on target date yields pool=$0, distributed=0, no errors", async () => {
    await insertPurchase(ledger, "tenant-a", 5000, "2026-02-27 12:00:00");

    const result = await runDividendCron(makeConfig());

    expect(result.skippedAlreadyRun).toBe(false);
    expect(result.pool.toCents()).toBe(0);
    expect(result.distributed).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
