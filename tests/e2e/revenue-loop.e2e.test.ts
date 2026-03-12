import { unlink } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@wopr-network/platform-core/test/db";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { CreditLedger, InsufficientBalanceError } from "@wopr-network/platform-core";
import { grantSignupCredits, SIGNUP_GRANT } from "@wopr-network/platform-core/monetization/credits/signup-grant";
import { BotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import { runRuntimeDeductions } from "@wopr-network/platform-core/monetization/credits/runtime-cron";
import { DrizzleMeterEmitter as MeterEmitter } from "@wopr-network/platform-core/monetization/metering/emitter";
import { MeterAggregator } from "@wopr-network/platform-core/monetization/metering/aggregator";
import { DrizzleUsageSummaryRepository } from "@wopr-network/platform-core/monetization/metering/drizzle-usage-summary-repository";
import { DrizzleMeterEventRepository } from "@wopr-network/platform-core/monetization/metering/meter-event-repository";
import { AdapterSocket } from "@wopr-network/platform-core/monetization/socket/socket";
import { Credit } from "@wopr-network/platform-core";
import { DrizzleBotInstanceRepository } from "@wopr-network/platform-core/fleet/drizzle-bot-instance-repository";
import type { BotInstance } from "@wopr-network/platform-core/fleet/repository-types";
import type { AdapterResult, ImageGenerationInput, ImageGenerationOutput, ProviderAdapter } from "@wopr-network/platform-core/monetization/adapters/types";

// ---------------------------------------------------------------------------
// Fake image-generation adapter — simulates a hosted provider (e.g., Replicate)
// ---------------------------------------------------------------------------

function createFakeImageGenAdapter(): ProviderAdapter {
  return {
    name: "fake-replicate-sdxl",
    capabilities: ["image-generation"],
    selfHosted: false,
    async generateImage(_input: ImageGenerationInput) {
      return {
        result: {
          images: ["https://fake-cdn.example.com/generated-image.png"],
          model: "sdxl-1.0",
        },
        cost: Credit.fromDollars(0.02), // $0.02 wholesale cost per image
      } satisfies AdapterResult<ImageGenerationOutput>;
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: core revenue loop — signup → bot → plugin → capability → credit consumed", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let botBilling: BotBilling;
  let meter: MeterEmitter;
  let aggregator: MeterAggregator;
  let socket: AdapterSocket;
  let walPath: string;
  let dlqPath: string;

  // Use unique IDs per test run to avoid cross-test collisions in the same DB
  const TENANT_ID = `e2e-revenue-${Date.now()}`;
  const BOT_ID = `bot-${Date.now()}`;
  const BOT_NAME = "e2e-test-bot";

  beforeEach(async () => {
    const ts = Date.now();
    walPath = `/tmp/wopr-e2e-wal-${ts}.jsonl`;
    dlqPath = `/tmp/wopr-e2e-dlq-${ts}.jsonl`;

    ({ db, pool } = await createTestDb());

    ledger = new CreditLedger(db);
    botBilling = new BotBilling(new DrizzleBotInstanceRepository(db));

    // Unique WAL/DLQ paths per run to avoid conflicts between parallel test runs.
    meter = new MeterEmitter(new DrizzleMeterEventRepository(db), {
      flushIntervalMs: 100,
      batchSize: 1,
      walPath,
      dlqPath,
    });

    aggregator = new MeterAggregator(new DrizzleUsageSummaryRepository(db));

    // Real AdapterSocket — no mocks of platform code.
    socket = new AdapterSocket({
      meter,
      defaultMargin: 1.3, // 30% margin
    });

    socket.register(createFakeImageGenAdapter());
  });

  afterEach(async () => {
    // Flush remaining meter events before closing the DB.
    meter.close();
    // Close pool last — meter.close() flushes synchronously so no race here.
    await pool.close();

    // Clean up temp WAL/DLQ files.
    await unlink(walPath).catch(() => {});
    await unlink(dlqPath).catch(() => {});
  });

  // =========================================================================
  // TEST 1: Complete revenue chain (the critical path)
  // =========================================================================

  it("complete revenue chain: signup → bot → capability → metered → credits deducted", async () => {
    // STEP 1: User signs up — tenant gets signup credits ($5.00)
    const granted = await grantSignupCredits(ledger, TENANT_ID);
    expect(granted).toBe(true);
    expect((await ledger.balance(TENANT_ID)).equals(SIGNUP_GRANT)).toBe(true);

    // STEP 2: User creates a bot instance
    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);
    const botInfo = (await botBilling.getBotBilling(BOT_ID)) as BotInstance | null;
    expect(botInfo).not.toBeNull();
    expect(botInfo!.billingState).toBe("active");
    expect(botInfo!.tenantId).toBe(TENANT_ID);
    expect(await botBilling.getActiveBotCount(TENANT_ID)).toBe(1);

    // STEP 3: Plugin declares capability requirement (image-generation) and
    //         platform routes the request to the registered adapter.
    const generatedImage = await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: {
        prompt: "A cyberpunk cat riding a skateboard",
        width: 1024,
        height: 1024,
      },
    });

    // Verify adapter returned a result
    expect(generatedImage.images).toHaveLength(1);
    expect(generatedImage.model).toBe("sdxl-1.0");

    // STEP 4: Verify meter event was emitted and flushed to DB.
    // Force flush to ensure the meter event is persisted.
    meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const event = events[0];
    expect(event.tenant).toBe(TENANT_ID);
    expect(event.capability).toBe("image-generation");
    expect(event.provider).toBe("fake-replicate-sdxl");
    // cost/charge in MeterEventRow are raw nanodollar integers
    const costDollars = Credit.fromRaw(event.cost).toDollars();
    const chargeDollars = Credit.fromRaw(event.charge).toDollars();
    expect(costDollars).toBeCloseTo(0.02, 5);
    // charge = cost * margin = 0.02 * 1.3 = 0.026
    expect(chargeDollars).toBeCloseTo(0.026, 5);

    // STEP 5: Usage aggregation rolls up into billing_period_summaries.
    const aggregated = await aggregator.aggregate();
    expect(aggregated).toBeGreaterThanOrEqual(0);

    // STEP 6: Credits are deducted from the tenant's balance.
    const chargeCredit = Credit.fromRaw(event.charge);
    expect(chargeCredit.isZero()).toBe(false);

    await ledger.debit(
      TENANT_ID,
      chargeCredit,
      "adapter_usage",
      `image-generation via fake-replicate-sdxl`,
      event.id, // referenceId for idempotency
    );

    const balanceAfter = await ledger.balance(TENANT_ID);
    expect(balanceAfter.lessThan(SIGNUP_GRANT)).toBe(true);
    expect(balanceAfter.isNegative()).toBe(false); // Still has credits left

    // Verify the transaction was recorded
    const history = await ledger.history(TENANT_ID);
    expect(history.length).toBe(2); // signup_grant + adapter_usage
    const debitTx = history.find((tx) => tx.type === "adapter_usage");
    expect(debitTx).toBeDefined();
    expect(debitTx!.amount.isNegative()).toBe(true); // negative for debits
    expect(debitTx!.referenceId).toBe(event.id);
  });

  // =========================================================================
  // TEST 2: Idempotent signup grant
  // =========================================================================

  it("idempotent signup grant — second call is a no-op", async () => {
    expect(await grantSignupCredits(ledger, TENANT_ID)).toBe(true);
    expect(await grantSignupCredits(ledger, TENANT_ID)).toBe(false);
    expect((await ledger.balance(TENANT_ID)).equals(SIGNUP_GRANT)).toBe(true);
  });

  // =========================================================================
  // TEST 3: Debit fails when balance is insufficient
  // =========================================================================

  it("debit throws InsufficientBalanceError when balance is insufficient", async () => {
    await grantSignupCredits(ledger, TENANT_ID);

    // Try to debit more than the balance
    await expect(
      ledger.debit(TENANT_ID, SIGNUP_GRANT.add(Credit.fromCents(1)), "adapter_usage", "should fail"),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  // =========================================================================
  // TEST 4: Bot suspension when credits run out during runtime deduction
  // =========================================================================

  it("bot suspended by runtime cron when credits are exhausted", async () => {
    // Grant minimal credits (1 cent — less than the 17-cent daily bot cost)
    await ledger.credit(TENANT_ID, Credit.fromCents(1), "promo", "tiny grant");
    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);

    expect(await botBilling.getActiveBotCount(TENANT_ID)).toBe(1);

    const result = await runRuntimeDeductions({
      ledger,
      date: new Date().toISOString().slice(0, 10),
      getActiveBotCount: (tid) => botBilling.getActiveBotCount(tid),
      onSuspend: async (tid) => {
        await botBilling.suspendAllForTenant(tid);
      },
    });

    expect(result.suspended).toContain(TENANT_ID);

    // After suspension, bot should be suspended
    const botInfo = (await botBilling.getBotBilling(BOT_ID)) as BotInstance | null;
    expect(botInfo!.billingState).toBe("suspended");
  });

  // =========================================================================
  // TEST 5: Bot reactivation after credit purchase
  // =========================================================================

  it("suspended bot reactivated after credit purchase", async () => {
    // Setup: grant minimal credits, register bot, exhaust balance, suspend
    await ledger.credit(TENANT_ID, Credit.fromCents(1), "promo", "tiny grant");
    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);
    await ledger.debit(TENANT_ID, Credit.fromCents(1), "bot_runtime", "exhaust balance");
    await botBilling.suspendAllForTenant(TENANT_ID);

    expect(((await botBilling.getBotBilling(BOT_ID)) as BotInstance | null)!.billingState).toBe("suspended");
    expect((await ledger.balance(TENANT_ID)).isZero()).toBe(true);

    // Simulate credit purchase (what the Stripe webhook handler does)
    await ledger.credit(TENANT_ID, Credit.fromCents(1000), "purchase", "Stripe credit purchase");
    const reactivated = await botBilling.checkReactivation(TENANT_ID, ledger);

    expect(reactivated).toContain(BOT_ID);
    expect(((await botBilling.getBotBilling(BOT_ID)) as BotInstance | null)!.billingState).toBe("active");
    expect((await ledger.balance(TENANT_ID)).equals(Credit.fromCents(1000))).toBe(true);
  });
});
