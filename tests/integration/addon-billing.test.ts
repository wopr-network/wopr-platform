import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { BotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import { DrizzleBotInstanceRepository } from "@wopr-network/platform-core/fleet/drizzle-bot-instance-repository";
import { Credit } from "@wopr-network/platform-core";
import { buildAddonCosts } from "@wopr-network/platform-core/monetization/addons/addon-cron";
import { ADDON_CATALOG } from "@wopr-network/platform-core/monetization/addons/addon-catalog";
import { DrizzleTenantAddonRepository } from "@wopr-network/platform-core/monetization/addons/addon-repository";
import { DrizzleLedger } from "@wopr-network/platform-core";
import { DAILY_BOT_COST, dailyBotCost, runRuntimeDeductions } from "@wopr-network/platform-core/monetization/credits/runtime-cron";
import { createTestDb, truncateAllTables } from "@wopr-network/platform-core/test/db";

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("E2E: addon billing — daily charges and enable/disable lifecycle", () => {
  const TODAY = "2026-01-15";
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: DrizzleLedger;
  let botInstanceRepo: DrizzleBotInstanceRepository;
  let botBilling: BotBilling;
  let addonRepo: DrizzleTenantAddonRepository;
  let getAddonCosts: (tenantId: string) => Promise<Credit>;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new DrizzleLedger(db);
    botInstanceRepo = new DrizzleBotInstanceRepository(db);
    botBilling = new BotBilling(botInstanceRepo, null);
    addonRepo = new DrizzleTenantAddonRepository(db);
    getAddonCosts = buildAddonCosts(addonRepo);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    await ledger.seedSystemAccounts();
  });

  it("charges $0.50/day for gpu_acceleration addon", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
    await botInstanceRepo.startBilling(botId);
    await ledger.credit(tenantId, Credit.fromCents(500), "purchase", "top-up");
    await addonRepo.enable(tenantId, "gpu_acceleration");

    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      getAddonCosts,
    });

    expect(result.processed).toBe(1);
    expect(result.suspended).toEqual([]);
    expect(result.errors).toEqual([]);

    // Balance = 500 - dailyBotCost (bot runtime) - 50 (gpu_acceleration)
    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500 - dailyBotCost(TODAY).toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents());

    const history = await ledger.history(tenantId);
    const addonTransactions = history.filter((tx) => tx.entryType === "addon");
    expect(addonTransactions).toHaveLength(1);
    expect(addonTransactions[0].description).toContain("add-on");
    // In double-entry: debit line on tenant liability account = spend amount (always positive)
    const addonLine = addonTransactions[0].lines.find((l) => l.side === "debit" && l.accountCode.startsWith("2000:"));
    expect(addonLine!.amount.toCents()).toBe(ADDON_CATALOG.gpu_acceleration.dailyCost.toCents());
  });

  it("stacks multiple addon charges ($0.50 + $0.20 = $0.70)", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
    await botInstanceRepo.startBilling(botId);
    await ledger.credit(tenantId, Credit.fromCents(500), "purchase", "top-up");
    await addonRepo.enable(tenantId, "gpu_acceleration");
    await addonRepo.enable(tenantId, "priority_queue");

    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      getAddonCosts,
    });

    expect(result.processed).toBe(1);
    expect(result.suspended).toEqual([]);
    expect(result.errors).toEqual([]);

    // Balance = 500 - dailyBotCost (bot) - 70 (gpu 50 + priority 20)
    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(
      500 - dailyBotCost(TODAY).toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents() - ADDON_CATALOG.priority_queue.dailyCost.toCents(),
    );
  });

  it("stops charging after addon is disabled", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
    await botInstanceRepo.startBilling(botId);
    await ledger.credit(tenantId, Credit.fromCents(500), "purchase", "top-up");

    // Enable addon, run cron day 1
    await addonRepo.enable(tenantId, "gpu_acceleration");

    const resultDay1 = await runRuntimeDeductions({
      ledger,
      date: "2026-01-15",
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      getAddonCosts,
    });
    expect(resultDay1.errors).toEqual([]);

    const balanceAfterDay1 = await ledger.balance(tenantId);
    // 500 - dailyBotCost("2026-01-15") - 50 (gpu addon)
    expect(balanceAfterDay1.toCents()).toBe(500 - dailyBotCost("2026-01-15").toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents());

    // Disable addon, run cron day 2
    await addonRepo.disable(tenantId, "gpu_acceleration");

    const resultDay2 = await runRuntimeDeductions({
      ledger,
      date: "2026-01-16",
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      getAddonCosts,
    });
    expect(resultDay2.errors).toEqual([]);

    const balanceAfterDay2 = await ledger.balance(tenantId);
    // balanceAfterDay1 - dailyBotCost("2026-01-16") (bot only, no addon)
    expect(balanceAfterDay2.toCents()).toBe(
      500 - dailyBotCost("2026-01-15").toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents() - dailyBotCost("2026-01-16").toCents(),
    );

    // Verify no addon transaction on day 2
    const history = await ledger.history(tenantId);
    const addonTxs = history.filter((tx) => tx.entryType === "addon");
    expect(addonTxs).toHaveLength(1); // Only day 1
  });

  it("suspends tenant when balance insufficient for addon after bot runtime deduction", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
    await botInstanceRepo.startBilling(botId);
    // Give enough for bot runtime plus a partial amount (less than gpu addon = 50 cents).
    await ledger.credit(tenantId, Credit.fromCents(dailyBotCost(TODAY).toCents() + 23), "purchase", "small-grant");
    await addonRepo.enable(tenantId, "gpu_acceleration");

    const onSuspend = vi.fn();

    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      getAddonCosts,
      onSuspend,
    });

    expect(result.processed).toBe(1);
    expect(result.suspended).toContain(tenantId);
    expect(result.errors).toEqual([]);
    expect(onSuspend).toHaveBeenCalledWith(tenantId);

    // Balance should be 0: (17 + 23) - 17 (bot) - 23 (partial addon) = 0
    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(0);

    // Verify partial addon debit exists
    const history = await ledger.history(tenantId);
    const addonTx = history.find((tx) => tx.entryType === "addon");
    expect(addonTx).toBeDefined();
    expect(addonTx!.description).toContain("Partial");
  });

  it("does not double-charge when billing runs twice on the same date", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
    await botInstanceRepo.startBilling(botId);
    await ledger.credit(tenantId, Credit.fromCents(500), "purchase", "top-up");
    await addonRepo.enable(tenantId, "gpu_acceleration");

    const cfg = {
      ledger,
      date: TODAY,
      getActiveBotCount: botBilling.getActiveBotCount.bind(botBilling),
      getAddonCosts,
    };

    const result1 = await runRuntimeDeductions(cfg);
    expect(result1.processed).toBe(1);
    expect(result1.skipped).toEqual([]);
    expect(result1.errors).toEqual([]);

    // Second run on same date — should skip the tenant, not charge again
    const result2 = await runRuntimeDeductions(cfg);
    expect(result2.processed).toBe(0);
    expect(result2.skipped).toContain(tenantId);
    expect(result2.errors).toEqual([]);

    // Balance unchanged after second run
    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(
      500 - dailyBotCost(TODAY).toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents(),
    );
  });
});
