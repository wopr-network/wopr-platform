import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { DrizzleBotInstanceRepository } from "@wopr-network/platform-core/fleet/drizzle-bot-instance-repository";
import { RESOURCE_TIERS } from "@wopr-network/platform-core/fleet/resource-tiers";
import { Credit } from "@wopr-network/platform-core";
import { BotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import { CreditLedger } from "@wopr-network/platform-core";
import {
  DAILY_BOT_COST,
  LOW_BALANCE_THRESHOLD,
  buildResourceTierCosts,
  runRuntimeDeductions,
} from "@wopr-network/platform-core/monetization/credits/runtime-cron";
import { createTestDb, truncateAllTables } from "@wopr-network/platform-core/test/db";

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("E2E: runtime billing cron — daily bot cost & suspension", () => {
  const TODAY = "2026-01-15";
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let botInstanceRepo: DrizzleBotInstanceRepository;
  let botBilling: BotBilling;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
    botInstanceRepo = new DrizzleBotInstanceRepository(db);
    botBilling = new BotBilling(botInstanceRepo, null);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("deducts $0.17 for a single active bot", async () => {
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot-1");
    await ledger.credit(tenantId, Credit.fromCents(500), "purchase", "top-up");

    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
    });

    expect(result.processed).toBe(1);
    expect(result.suspended).toEqual([]);
    expect(result.errors).toEqual([]);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500 - DAILY_BOT_COST.toCents());

    const history = await ledger.history(tenantId);
    const debit = history.find((tx) => tx.type === "bot_runtime");
    expect(debit).toBeDefined();
    expect(debit!.description).toContain("1 bot(s)");
  });

  it("deducts 3 x $0.17 for three active bots", async () => {
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;

    for (let i = 0; i < 3; i++) {
      await botBilling.registerBot(randomUUID(), tenantId, `bot-${i}`);
    }
    await ledger.credit(tenantId, Credit.fromCents(500), "purchase", "top-up");

    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
    });

    expect(result.processed).toBe(1);
    expect(result.suspended).toEqual([]);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500 - 3 * DAILY_BOT_COST.toCents());
  });

  it("partially debits and suspends when balance is less than daily cost", async () => {
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "low-balance-bot");
    await ledger.credit(tenantId, Credit.fromCents(10), "purchase", "tiny-grant");

    const onSuspend = vi.fn(async (tid: string) => {
      await botBilling.suspendAllForTenant(tid);
    });

    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      onSuspend,
    });

    expect(result.processed).toBe(1);
    expect(result.suspended).toContain(tenantId);
    expect(onSuspend).toHaveBeenCalledWith(tenantId);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(0);

    const bot = (await botBilling.getBotBilling(botId)) as { billingState: string };
    expect(bot.billingState).toBe("suspended");
  });

  it("fires onLowBalance when balance crosses below $1.00 threshold", async () => {
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "low-bal-bot");
    const startCents = LOW_BALANCE_THRESHOLD.toCents() + DAILY_BOT_COST.toCents() - 7;
    await ledger.credit(tenantId, Credit.fromCents(startCents), "purchase", "grant");

    const onLowBalance = vi.fn();

    await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      onLowBalance,
    });

    expect(onLowBalance).toHaveBeenCalledOnce();
    const [calledTenant, calledBalance] = onLowBalance.mock.calls[0];
    expect(calledTenant).toBe(tenantId);
    expect(calledBalance.toCents()).toBe(startCents - DAILY_BOT_COST.toCents());
  });

  it("is idempotent — second run on same date skips already-billed tenants", async () => {
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    await botBilling.registerBot(randomUUID(), tenantId, "idem-bot");
    await ledger.credit(tenantId, Credit.fromCents(500), "purchase", "grant");

    const cfg = {
      ledger,
      date: "2026-06-15",
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
    };

    const first = await runRuntimeDeductions(cfg);
    expect(first.processed).toBe(1);
    expect((await ledger.balance(tenantId)).toCents()).toBe(500 - DAILY_BOT_COST.toCents());

    const second = await runRuntimeDeductions(cfg);
    expect(second.processed).toBe(0);
    expect(second.skipped).toContain(tenantId);
    expect((await ledger.balance(tenantId)).toCents()).toBe(500 - DAILY_BOT_COST.toCents());
  });

  it("charges resource tier surcharge on top of base cost for pro-tier bot", async () => {
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "pro-bot");
    await botInstanceRepo.setResourceTier(botId, "pro");

    const proSurcharge = RESOURCE_TIERS.pro.dailyCost.toCents(); // 10 cents
    const totalExpected = DAILY_BOT_COST.toCents() + proSurcharge;
    const startBalance = totalExpected + 50;
    await ledger.credit(tenantId, Credit.fromCents(startBalance), "purchase", "grant");

    const getResourceTierCosts = buildResourceTierCosts(
      botInstanceRepo,
      async (tid: string) => botInstanceRepo.listActiveIdsByTenant(tid),
    );

    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      getResourceTierCosts,
    });

    expect(result.processed).toBe(1);
    expect(result.suspended).toEqual([]);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(startBalance - totalExpected);

    const history = await ledger.history(tenantId);
    const types = history.map((tx) => tx.type);
    expect(types).toContain("bot_runtime");
    expect(types).toContain("resource_upgrade");
  });
});
