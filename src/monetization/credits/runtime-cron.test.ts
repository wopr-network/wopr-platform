import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_TIERS } from "../../fleet/resource-tiers.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger, InsufficientBalanceError } from "./credit-ledger.js";
import { buildResourceTierCosts, DAILY_BOT_COST, runRuntimeDeductions } from "./runtime-cron.js";

describe("runRuntimeDeductions", () => {
  let pool: PGlite;
  let ledger: CreditLedger;

  beforeAll(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    ledger = new CreditLedger(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("DAILY_BOT_COST equals 17 cents", () => {
    expect(DAILY_BOT_COST.toCents()).toBe(17);
  });

  it("returns empty result when no tenants have balance", async () => {
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 0,
    });
    expect(result.processed).toBe(0);
    expect(result.suspended).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("skips tenants with zero active bots", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 0,
    });
    expect(result.processed).toBe(0);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(500);
  });

  it("deducts full amount when balance is sufficient", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 2,
    });
    expect(result.processed).toBe(1);
    expect(result.suspended).toEqual([]);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(500 - 2 * 17);
  });

  it("partial deduction and suspension when balance is insufficient", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(10), "purchase", "top-up");
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onSuspend,
    });
    expect(result.processed).toBe(1);
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
    expect((await ledger.balance("tenant-1")).toCents()).toBe(0);
  });

  it("suspends with zero partial when balance exactly zero", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(100), "purchase", "top-up");
    await ledger.debit("tenant-1", Credit.fromCents(100), "bot_runtime", "drain");
    await ledger.credit("tenant-1", Credit.fromCents(1), "purchase", "tiny");

    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onSuspend,
    });
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
    expect((await ledger.balance("tenant-1")).toCents()).toBe(0);
  });

  it("suspends without onSuspend callback", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(5), "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
    });
    expect(result.suspended).toContain("tenant-1");
    expect(result.processed).toBe(1);
  });

  it("handles errors from getActiveBotCount gracefully", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => {
        throw new Error("db connection failed");
      },
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("tenant-1");
    expect(result.errors[0]).toContain("db connection failed");
  });

  it("handles InsufficientBalanceError from ledger.debit", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "top-up");
    await ledger.debit("tenant-1", Credit.fromCents(499), "bot_runtime", "drain");
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onSuspend,
    });
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
  });

  it("catches InsufficientBalanceError from debit and suspends", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "top-up");
    vi.spyOn(ledger, "debit").mockRejectedValue(
      new InsufficientBalanceError(Credit.fromCents(0), Credit.fromCents(17)),
    );
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onSuspend,
    });
    expect(result.suspended).toContain("tenant-1");
    expect(onSuspend).toHaveBeenCalledWith("tenant-1");
    expect(result.processed).toBe(1);
    vi.restoreAllMocks();
  });

  it("catches InsufficientBalanceError without onSuspend callback", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "top-up");
    vi.spyOn(ledger, "debit").mockRejectedValue(
      new InsufficientBalanceError(Credit.fromCents(0), Credit.fromCents(17)),
    );
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
    });
    expect(result.suspended).toContain("tenant-1");
    expect(result.processed).toBe(1);
    vi.restoreAllMocks();
  });

  it("processes multiple tenants", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "top-up");
    await ledger.credit("tenant-2", Credit.fromCents(10), "purchase", "top-up");
    const onSuspend = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onSuspend,
    });
    expect(result.processed).toBe(2);
    expect(result.suspended).toContain("tenant-2");
    expect(result.suspended).not.toContain("tenant-1");
  });

  it("fires onLowBalance when balance drops below 100 cents threshold", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(110), "purchase", "top-up");
    const onLowBalance = vi.fn();
    await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onLowBalance,
    });
    expect(onLowBalance).toHaveBeenCalledOnce();
    const [calledTenant, calledBalance] = onLowBalance.mock.calls[0];
    expect(calledTenant).toBe("tenant-1");
    expect(calledBalance.toCents()).toBe(93);
  });

  it("does NOT fire onLowBalance when balance was already below threshold before deduction", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(90), "purchase", "top-up");
    const onLowBalance = vi.fn();
    await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onLowBalance,
    });
    expect(onLowBalance).not.toHaveBeenCalled();
  });

  it("fires onCreditsExhausted when full deduction causes balance to drop to 0", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(17), "purchase", "top-up");
    const onCreditsExhausted = vi.fn();
    await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onCreditsExhausted,
    });
    expect(onCreditsExhausted).toHaveBeenCalledWith("tenant-1");
    expect((await ledger.balance("tenant-1")).toCents()).toBe(0);
  });

  it("fires onCreditsExhausted on partial deduction when balance hits 0", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(10), "purchase", "top-up");
    const onCreditsExhausted = vi.fn();
    await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      onCreditsExhausted,
    });
    expect(onCreditsExhausted).toHaveBeenCalledWith("tenant-1");
    expect((await ledger.balance("tenant-1")).toCents()).toBe(0);
  });

  it("partially debits resource tier surcharge when balance is positive but insufficient", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(30), "purchase", "top-up");
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      getResourceTierCosts: async () => Credit.fromCents(50),
    });
    expect(result.processed).toBe(1);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(0);
  });

  it("skips resource tier partial debit when balance is exactly 0 after runtime", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(17), "purchase", "top-up");
    const onCreditsExhausted = vi.fn();
    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      getResourceTierCosts: async () => Credit.fromCents(50),
      onCreditsExhausted,
    });
    expect(result.processed).toBe(1);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(0);
    expect(onCreditsExhausted).toHaveBeenCalledWith("tenant-1");
  });

  it("buildResourceTierCosts: deducts pro tier surcharge via getResourceTierCosts", async () => {
    const proTierCost = RESOURCE_TIERS.pro.dailyCost.toCents();
    const startBalance = 17 + proTierCost + 10;
    await ledger.credit("tenant-1", Credit.fromCents(startBalance), "purchase", "top-up");

    const mockRepo = {
      getResourceTier: async (_botId: string): Promise<string | null> => "pro",
    };

    const getResourceTierCosts = buildResourceTierCosts(
      mockRepo as unknown as Parameters<typeof buildResourceTierCosts>[0],
      async (_tenantId: string) => ["bot-1"],
    );

    await runRuntimeDeductions({
      ledger,
      getActiveBotCount: async () => 1,
      getResourceTierCosts,
    });

    const expected = startBalance - 17 - proTierCost;
    expect((await ledger.balance("tenant-1")).toCents()).toBe(expected);
  });
});
