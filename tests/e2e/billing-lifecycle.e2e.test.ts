import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { CreditLedger, InsufficientBalanceError } from "../../src/monetization/credits/credit-ledger.js";
import { Credit } from "../../src/monetization/credit.js";
import { CREDIT_PRICE_POINTS, getCreditAmountForPurchase } from "../../src/monetization/stripe/credit-prices.js";
import { RateStore } from "../../src/admin/rates/rate-store.js";
import { BotBilling } from "../../src/monetization/credits/bot-billing.js";
import { DrizzleBotInstanceRepository } from "../../src/fleet/drizzle-bot-instance-repository.js";
import { DrizzleMeterEmitter as MeterEmitter } from "../../src/monetization/metering/emitter.js";
import { DrizzleMeterEventRepository } from "../../src/monetization/metering/meter-event-repository.js";
import { MeterAggregator } from "../../src/monetization/metering/aggregator.js";
import { DrizzleUsageSummaryRepository } from "../../src/monetization/metering/drizzle-usage-summary-repository.js";
import { AdapterSocket } from "../../src/monetization/socket/socket.js";
import { checkInstanceQuota, DEFAULT_INSTANCE_LIMITS } from "../../src/monetization/quotas/quota-check.js";
import type { InstanceLimits } from "../../src/monetization/quotas/quota-check.js";
import type {
  AdapterResult,
  ImageGenerationInput,
  ImageGenerationOutput,
  ProviderAdapter,
} from "../../src/monetization/adapters/types.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function createFakeAdapter(): ProviderAdapter {
  return {
    name: "fake-billing-test-adapter",
    capabilities: ["image-generation"],
    selfHosted: false,
    async generateImage(_input: ImageGenerationInput) {
      return {
        result: {
          images: ["https://fake-cdn.example.com/img.png"],
          model: "test-model",
        },
        cost: Credit.fromDollars(0.01),
      } satisfies AdapterResult<ImageGenerationOutput>;
    },
  };
}

describe("E2E: billing lifecycle — pricing → purchase → usage → upgrade/downgrade", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let rateStore: RateStore;
  let botBilling: BotBilling;
  let meter: MeterEmitter;
  let aggregator: MeterAggregator;
  let socket: AdapterSocket;
  let walPath: string;
  let dlqPath: string;
  let TENANT_ID: string;
  let BOT_ID: string;

  beforeEach(async () => {
    const ts = Date.now();
    walPath = `/tmp/wopr-e2e-billing-wal-${ts}.jsonl`;
    dlqPath = `/tmp/wopr-e2e-billing-dlq-${ts}.jsonl`;

    ({ db, pool } = await createTestDb());

    TENANT_ID = `e2e-billing-${randomUUID().slice(0, 8)}`;
    BOT_ID = randomUUID();

    ledger = new CreditLedger(db);
    rateStore = new RateStore(db);
    botBilling = new BotBilling(new DrizzleBotInstanceRepository(db));

    meter = new MeterEmitter(new DrizzleMeterEventRepository(db), {
      flushIntervalMs: 100,
      batchSize: 1,
      walPath,
      dlqPath,
    });

    aggregator = new MeterAggregator(new DrizzleUsageSummaryRepository(db));

    socket = new AdapterSocket({
      meter,
      defaultMargin: 1.3,
    });
    socket.register(createFakeAdapter());
  });

  afterEach(async () => {
    meter.close();
    await pool.close();
    await unlink(walPath).catch(() => {});
    await unlink(dlqPath).catch(() => {});
  });

  // TEST 1: Public pricing tiers
  it("fetches public pricing tiers from RateStore", async () => {
    await rateStore.createSellRate({
      capability: "tts",
      displayName: "Text to Speech",
      unit: "1000 chars",
      priceUsd: 0.015,
      isActive: true,
      sortOrder: 0,
    });
    await rateStore.createSellRate({
      capability: "image-generation",
      displayName: "Image Generation",
      unit: "image",
      priceUsd: 0.02,
      isActive: true,
      sortOrder: 0,
    });
    // Inactive rate should NOT appear
    await rateStore.createSellRate({
      capability: "llm",
      displayName: "LLM (deprecated)",
      unit: "1k tokens",
      priceUsd: 0.005,
      isActive: false,
      sortOrder: 0,
    });

    const rates = await rateStore.listPublicRates();
    expect(rates).toHaveLength(2);
    expect(rates.map((r) => r.capability).sort()).toEqual(["image-generation", "tts"]);

    // Verify credit price points are available (static config)
    expect(CREDIT_PRICE_POINTS).toHaveLength(5);
    const tier5 = CREDIT_PRICE_POINTS.find((p) => p.amountCents === 500);
    expect(tier5).toBeDefined();
    const tier100 = CREDIT_PRICE_POINTS.find((p) => p.amountCents === 10000);
    expect(tier100).toBeDefined();
    expect(tier100!.bonusPercent).toBe(10);
  });

  // TEST 2: Credit purchase simulates subscription creation
  it("purchases credits at $5 tier (no bonus) and verifies balance", async () => {
    const tier = CREDIT_PRICE_POINTS.find((p) => p.amountCents === 500)!; // $5, 0% bonus
    const creditAmount = getCreditAmountForPurchase(tier.amountCents);
    expect(creditAmount).toBe(500); // no bonus

    await ledger.credit(TENANT_ID, Credit.fromCents(creditAmount), "purchase", `Credit purchase: ${tier.label}`);

    const balance = await ledger.balance(TENANT_ID);
    expect(balance.toCents()).toBe(500);

    const history = await ledger.history(TENANT_ID);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("purchase");
  });

  // TEST 3: Record usage and verify quota enforcement
  it("records usage via adapter socket and enforces quota limits", async () => {
    // Setup: purchase credits and register bot
    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Initial purchase");
    await botBilling.registerBot(BOT_ID, TENANT_ID, "billing-test-bot");

    // Execute adapter call — this emits a meter event
    const result = await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: { prompt: "test image", width: 512, height: 512 },
    });
    expect(result.images).toHaveLength(1);

    // Flush meter events
    await meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const event = events[0];
    expect(event.capability).toBe("image-generation");

    // Deduct usage from balance
    const chargeCredit = Credit.fromRaw(event.charge);
    await ledger.debit(TENANT_ID, chargeCredit, "adapter_usage", "image-generation usage", event.id);

    const balanceAfter = await ledger.balance(TENANT_ID);
    expect(balanceAfter.lessThan(Credit.fromCents(500))).toBe(true);
    expect(balanceAfter.isNegative()).toBe(false);

    // Quota enforcement with custom limits (maxInstances=2)
    const limits: InstanceLimits = { maxInstances: 2, label: "test" };
    const quotaOk = checkInstanceQuota(limits, 1);
    expect(quotaOk.allowed).toBe(true);

    const quotaFull = checkInstanceQuota(limits, 2);
    expect(quotaFull.allowed).toBe(false);
    expect(quotaFull.reason).toContain("quota exceeded");
  });

  // TEST 4: Upgrade to higher tier with bonus
  it("upgrade from $5 to $100 tier — bonus credits apply immediately", async () => {
    // Initial purchase at $5 tier (no bonus)
    const tier5 = CREDIT_PRICE_POINTS.find((p) => p.amountCents === 500)!;
    await ledger.credit(
      TENANT_ID,
      Credit.fromCents(getCreditAmountForPurchase(tier5.amountCents)),
      "purchase",
      "Tier $5",
    );

    const balanceAfter5 = await ledger.balance(TENANT_ID);
    expect(balanceAfter5.toCents()).toBe(500);

    // "Upgrade" — purchase at $100 tier (10% bonus: pay $100, get $110)
    const tier100 = CREDIT_PRICE_POINTS.find((p) => p.amountCents === 10000)!;
    const creditAmount100 = getCreditAmountForPurchase(tier100.amountCents);
    expect(creditAmount100).toBe(11000); // $110 in cents

    await ledger.credit(TENANT_ID, Credit.fromCents(creditAmount100), "purchase", "Tier $100 upgrade");

    const balanceAfterUpgrade = await ledger.balance(TENANT_ID);
    // 500 + 11000 = 11500 cents
    expect(balanceAfterUpgrade.toCents()).toBe(11500);

    // Verify transaction history shows both purchases
    const history = await ledger.history(TENANT_ID);
    expect(history).toHaveLength(2);
    expect(history.filter((tx) => tx.type === "purchase")).toHaveLength(2);
  });

  // TEST 5: Downgrade — usage exceeding balance is rejected gracefully
  it("downgrade scenario — debit fails gracefully when usage exceeds remaining balance", async () => {
    // Purchase small amount (simulating a "downgrade" to lower tier)
    await ledger.credit(TENANT_ID, Credit.fromCents(100), "purchase", "Small tier purchase");

    // Use some credits
    await ledger.debit(TENANT_ID, Credit.fromCents(80), "adapter_usage", "usage chunk 1");

    // Balance is now 20 cents — trying to debit 50 should fail
    await expect(
      ledger.debit(TENANT_ID, Credit.fromCents(50), "adapter_usage", "should fail — exceeds balance"),
    ).rejects.toThrow(InsufficientBalanceError);

    // Balance unchanged after failed debit
    const balance = await ledger.balance(TENANT_ID);
    expect(balance.toCents()).toBe(20);

    // Can still debit up to remaining balance
    await ledger.debit(TENANT_ID, Credit.fromCents(20), "adapter_usage", "use remaining");
    expect((await ledger.balance(TENANT_ID)).isZero()).toBe(true);
  });

  // TEST 6: Billing audit trail captures all tier transitions
  it("audit trail records all purchases and debits with correct types", async () => {
    // Multiple purchases at different tiers
    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Tier $5");
    await ledger.credit(TENANT_ID, Credit.fromCents(2550), "purchase", "Tier $25 (2% bonus)");

    // Usage deductions
    await ledger.debit(TENANT_ID, Credit.fromCents(100), "adapter_usage", "TTS usage");
    await ledger.debit(TENANT_ID, Credit.fromCents(200), "bot_runtime", "Daily bot cost");

    const history = await ledger.history(TENANT_ID);
    expect(history).toHaveLength(4);

    // Verify types
    const types = history.map((tx) => tx.type);
    expect(types.filter((t) => t === "purchase")).toHaveLength(2);
    expect(types).toContain("adapter_usage");
    expect(types).toContain("bot_runtime");

    // Verify balance is correct: 500 + 2550 - 100 - 200 = 2750
    const balance = await ledger.balance(TENANT_ID);
    expect(balance.toCents()).toBe(2750);
  });

  // TEST 7: Free tier (zero balance) has correct default limits
  it("free tier — zero balance tenant gets correct default quota", async () => {
    // No credits purchased — balance is zero
    const balance = await ledger.balance(TENANT_ID);
    expect(balance.isZero()).toBe(true);

    // Default instance limits allow unlimited instances (observable behavior)
    const quota = checkInstanceQuota(DEFAULT_INSTANCE_LIMITS, 5);
    expect(quota.allowed).toBe(true);

    // But with a restrictive plan, zero-balance user is blocked
    const restrictiveLimits: InstanceLimits = { maxInstances: 1, label: "free" };
    const restricted = checkInstanceQuota(restrictiveLimits, 1);
    expect(restricted.allowed).toBe(false);
  });

  // TEST 8: Concurrent usage recording during tier change
  it("concurrent usage recording — multiple debits in sequence don't corrupt balance", async () => {
    await ledger.credit(TENANT_ID, Credit.fromCents(1000), "purchase", "Initial");

    // Simulate rapid sequential usage (what happens during a tier change)
    const debitPromises = Array.from({ length: 5 }, (_, i) =>
      ledger.debit(TENANT_ID, Credit.fromCents(100), "adapter_usage", `concurrent debit ${i}`, randomUUID()),
    );

    await Promise.all(debitPromises);

    const balance = await ledger.balance(TENANT_ID);
    // 1000 - (5 * 100) = 500
    expect(balance.toCents()).toBe(500);

    const history = await ledger.history(TENANT_ID);
    // 1 credit + 5 debits = 6
    expect(history).toHaveLength(6);
  });

  // TEST 9: Bot suspension on balance exhaustion after downgrade
  it("bot suspended when balance exhausted after downgrade", async () => {
    await ledger.credit(TENANT_ID, Credit.fromCents(50), "purchase", "Tiny purchase");
    await botBilling.registerBot(BOT_ID, TENANT_ID, "downgrade-bot");

    // Exhaust balance
    await ledger.debit(TENANT_ID, Credit.fromCents(50), "adapter_usage", "exhaust");
    expect((await ledger.balance(TENANT_ID)).isZero()).toBe(true);

    // Suspend bot (what the runtime cron would do)
    await botBilling.suspendAllForTenant(TENANT_ID);
    const bot = (await botBilling.getBotBilling(BOT_ID)) as { billingState: string };
    expect(bot.billingState).toBe("suspended");

    // Purchase more credits (re-subscribe at any tier)
    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Re-purchase");
    const reactivated = await botBilling.checkReactivation(TENANT_ID, ledger);
    expect(reactivated).toContain(BOT_ID);

    const botAfter = (await botBilling.getBotBilling(BOT_ID)) as { billingState: string };
    expect(botAfter.billingState).toBe("active");
  });
});
