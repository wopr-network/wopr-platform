import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { BotBilling } from "../../src/monetization/credits/bot-billing.js";
import { DrizzleBotInstanceRepository } from "../../src/fleet/drizzle-bot-instance-repository.js";
import { Credit } from "../../src/monetization/credit.js";
import { buildAddonCosts } from "../../src/monetization/addons/addon-cron.js";
import { ADDON_CATALOG } from "../../src/monetization/addons/addon-catalog.js";
import { DrizzleTenantAddonRepository } from "../../src/monetization/addons/addon-repository.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { DAILY_BOT_COST, runRuntimeDeductions } from "../../src/monetization/credits/runtime-cron.js";
import { createTestDb, truncateAllTables } from "../../src/test/db.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("E2E: addon billing — daily charges and enable/disable lifecycle", () => {
  const TODAY = "2026-01-15";
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let botInstanceRepo: DrizzleBotInstanceRepository;
  let botBilling: BotBilling;
  let addonRepo: DrizzleTenantAddonRepository;
  let getAddonCosts: (tenantId: string) => Promise<Credit>;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
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
  });

  it("charges $0.50/day for gpu_acceleration addon", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
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

    // Balance = 500 - 17 (bot runtime) - 50 (gpu_acceleration) = 433
    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500 - DAILY_BOT_COST.toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents());

    const history = await ledger.history(tenantId);
    const addonTransactions = history.filter((tx) => tx.type === "addon");
    expect(addonTransactions).toHaveLength(1);
    expect(addonTransactions[0].description).toContain("add-on");
    expect(addonTransactions[0].amount.toCents()).toBe(-ADDON_CATALOG.gpu_acceleration.dailyCost.toCents());
  });

  it("stacks multiple addon charges ($0.50 + $0.20 = $0.70)", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
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

    // Balance = 500 - 17 (bot) - 70 (gpu 50 + priority 20) = 413
    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(
      500 - DAILY_BOT_COST.toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents() - ADDON_CATALOG.priority_queue.dailyCost.toCents(),
    );
  });

  it("stops charging after addon is disabled", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
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
    // 500 - 17 - 50 = 433
    expect(balanceAfterDay1.toCents()).toBe(500 - DAILY_BOT_COST.toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents());

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
    // 433 - 17 (bot only, no addon) = 416
    expect(balanceAfterDay2.toCents()).toBe(
      500 - DAILY_BOT_COST.toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents() - DAILY_BOT_COST.toCents(),
    );

    // Verify no addon transaction on day 2
    const history = await ledger.history(tenantId);
    const addonTxs = history.filter((tx) => tx.type === "addon");
    expect(addonTxs).toHaveLength(1); // Only day 1
  });

  it("suspends tenant when balance insufficient for addon after bot runtime deduction", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
    // Bot cost = 17, gpu addon = 50. Give bot cost + partial: enough for runtime but not addon.
    await ledger.credit(tenantId, Credit.fromCents(DAILY_BOT_COST.toCents() + 23), "purchase", "small-grant");
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
    const addonTx = history.find((tx) => tx.type === "addon");
    expect(addonTx).toBeDefined();
    expect(addonTx!.description).toContain("Partial");
  });

  it("does not double-charge when billing runs twice on the same date", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const botId = randomUUID();

    await botBilling.registerBot(botId, tenantId, "test-bot");
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
      500 - DAILY_BOT_COST.toCents() - ADDON_CATALOG.gpu_acceleration.dailyCost.toCents(),
    );
  });
});
