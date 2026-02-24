import { unlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { CreditLedger, InsufficientBalanceError } from "../../src/monetization/credits/credit-ledger.js";
import { grantSignupCredits, SIGNUP_GRANT_CENTS } from "../../src/monetization/credits/signup-grant.js";
import { BotBilling } from "../../src/monetization/credits/bot-billing.js";
import { runRuntimeDeductions } from "../../src/monetization/credits/runtime-cron.js";
import { MeterEmitter } from "../../src/monetization/metering/emitter.js";
import { MeterAggregator } from "../../src/monetization/metering/aggregator.js";
import { AdapterSocket } from "../../src/monetization/socket/socket.js";
import type { AdapterResult, ImageGenerationOutput, ProviderAdapter } from "../../src/monetization/adapters/types.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Fake image-generation adapter — simulates a hosted provider (e.g., Replicate)
// ---------------------------------------------------------------------------

function createFakeImageGenAdapter(): ProviderAdapter {
  return {
    name: "fake-replicate-sdxl",
    capabilities: ["image-generation"],
    selfHosted: false,
    async generateImage() {
      return {
        result: {
          images: ["https://fake-cdn.example.com/generated-image.png"],
          model: "sdxl-1.0",
        },
        cost: 0.02, // $0.02 wholesale cost per image
      } satisfies AdapterResult<ImageGenerationOutput>;
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: core revenue loop — signup → bot → plugin → capability → credit consumed", () => {
  let db: DrizzleDb;
  let sqlite: Database.Database;
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

  beforeEach(() => {
    const ts = Date.now();
    walPath = `/tmp/wopr-e2e-wal-${ts}.jsonl`;
    dlqPath = `/tmp/wopr-e2e-dlq-${ts}.jsonl`;

    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    ledger = new CreditLedger(db);
    botBilling = new BotBilling(db);

    // Unique WAL/DLQ paths per run to avoid conflicts between parallel test runs.
    meter = new MeterEmitter(db, {
      flushIntervalMs: 100,
      batchSize: 1,
      walPath,
      dlqPath,
    });

    aggregator = new MeterAggregator(db);

    // Real AdapterSocket — no mocks of platform code.
    socket = new AdapterSocket({
      meter,
      defaultMargin: 1.3, // 30% margin
    });

    socket.register(createFakeImageGenAdapter());
  });

  afterEach(async () => {
    // Flush remaining meter events to SQLite before closing the DB.
    meter.close();
    // Close SQLite last — meter.close() flushes synchronously so no race here.
    sqlite.close();

    // Clean up temp WAL/DLQ files.
    await unlink(walPath).catch(() => {});
    await unlink(dlqPath).catch(() => {});
  });

  // =========================================================================
  // TEST 1: Complete revenue chain (the critical path)
  // =========================================================================

  it("complete revenue chain: signup → bot → capability → metered → credits deducted", async () => {
    // STEP 1: User signs up — tenant gets signup credits ($5.00 = 500 cents)
    const granted = grantSignupCredits(ledger, TENANT_ID);
    expect(granted).toBe(true);
    expect(ledger.balance(TENANT_ID)).toBe(SIGNUP_GRANT_CENTS); // 500 cents

    // STEP 2: User creates a bot instance
    botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);
    const botInfo = botBilling.getBotBilling(BOT_ID);
    expect(botInfo).not.toBeNull();
    expect(botInfo!.billingState).toBe("active");
    expect(botInfo!.tenantId).toBe(TENANT_ID);
    expect(botBilling.getActiveBotCount(TENANT_ID)).toBe(1);

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
    // Force flush to ensure the meter event is persisted to SQLite.
    meter.flush();

    const events = meter.queryEvents(TENANT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const event = events[0];
    expect(event.tenant).toBe(TENANT_ID);
    expect(event.capability).toBe("image-generation");
    expect(event.provider).toBe("fake-replicate-sdxl");
    expect(event.cost).toBeCloseTo(0.02, 5);
    // charge = cost * margin = 0.02 * 1.3 = 0.026
    expect(event.charge).toBeCloseTo(0.026, 5);

    // STEP 5: Usage aggregation rolls up into billing_period_summaries.
    const aggregated = aggregator.aggregate();
    expect(aggregated).toBeGreaterThanOrEqual(0);

    // STEP 6: Credits are deducted from the tenant's balance.
    // Convert charge (USD) to cents for the ledger.
    const chargeCents = Math.round(event.charge * 100); // 0.026 * 100 = 3 cents (rounded)
    expect(chargeCents).toBeGreaterThan(0);

    ledger.debit(
      TENANT_ID,
      chargeCents,
      "adapter_usage",
      `image-generation via fake-replicate-sdxl`,
      event.id, // referenceId for idempotency
    );

    const balanceAfter = ledger.balance(TENANT_ID);
    expect(balanceAfter).toBe(SIGNUP_GRANT_CENTS - chargeCents);
    expect(balanceAfter).toBeLessThan(SIGNUP_GRANT_CENTS);
    expect(balanceAfter).toBeGreaterThan(0); // Still has credits left

    // Verify the transaction was recorded
    const history = ledger.history(TENANT_ID);
    expect(history.length).toBe(2); // signup_grant + adapter_usage
    const debitTx = history.find((tx) => tx.type === "adapter_usage");
    expect(debitTx).toBeDefined();
    expect(debitTx!.amountCents).toBe(-chargeCents); // negative for debits
    expect(debitTx!.referenceId).toBe(event.id);
  });

  // =========================================================================
  // TEST 2: Stripe reporting (conditional on STRIPE_SECRET_KEY)
  // =========================================================================

  it.skipIf(!stripeAvailable)(
    "bonus: Stripe receives usage event in test mode",
    async () => {
      const stripe = new Stripe(STRIPE_KEY!);

      // Create a real Stripe test-mode customer to map to the tenant.
      const customer = await stripe.customers.create({
        email: `e2e-test-${Date.now()}@wopr.bot`,
        metadata: { wopr_tenant: TENANT_ID, test: "true" },
      });

      try {
        tenantStore.upsert({
          tenant: TENANT_ID,
          processorCustomerId: customer.id,
        });

        // Run the full chain
        grantSignupCredits(ledger, TENANT_ID);
        botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);

        await socket.execute<ImageGenerationOutput>({
          tenantId: TENANT_ID,
          capability: "image-generation",
          input: { prompt: "test image for Stripe reporting" },
        });

        meter.flush();

        // Poll until the billing period has elapsed (up to 3s to tolerate slow CI).
        const periodBoundary2 = aggregator.getBillingPeriod(Date.now()).start + 1_000;
        for (let i = 0; i < 60; i++) {
          if (Date.now() >= periodBoundary2) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        aggregator.aggregate();

        // Create reporter and send to Stripe
        const reporter = new StripeUsageReporter(db, stripe, tenantStore, {
          intervalMs: 999_999, // Don't auto-run
        });

        const reported = await reporter.report();
        expect(reported).toBeGreaterThanOrEqual(1);

        // Verify the report was recorded locally
        const reports = reporter.queryReports(TENANT_ID);
        expect(reports.length).toBeGreaterThanOrEqual(1);
        expect(reports[0].event_name).toBe("wopr_image_generation_usage");
        expect(reports[0].value_cents).toBeGreaterThan(0);
      } finally {
        // Clean up test Stripe customer regardless of test outcome
        await stripe.customers.del(customer.id);
      }
    },
  );

  // =========================================================================
  // TEST 3: Idempotent signup grant
  // =========================================================================

  it("idempotent signup grant — second call is a no-op", () => {
    expect(grantSignupCredits(ledger, TENANT_ID)).toBe(true);
    expect(grantSignupCredits(ledger, TENANT_ID)).toBe(false);
    expect(ledger.balance(TENANT_ID)).toBe(SIGNUP_GRANT_CENTS);
  });

  // =========================================================================
  // TEST 3: Debit fails when balance is insufficient
  // =========================================================================

  it("debit throws InsufficientBalanceError when balance is insufficient", () => {
    grantSignupCredits(ledger, TENANT_ID);

    // Try to debit more than the balance
    expect(() => {
      ledger.debit(TENANT_ID, SIGNUP_GRANT_CENTS + 1, "adapter_usage", "should fail");
    }).toThrow(InsufficientBalanceError);
  });

  // =========================================================================
  // TEST 4: Bot suspension when credits run out during runtime deduction
  // =========================================================================

  it("bot suspended by runtime cron when credits are exhausted", async () => {
    // Grant minimal credits (1 cent — less than the 17-cent daily bot cost)
    ledger.credit(TENANT_ID, 1, "promo", "tiny grant");
    botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);

    expect(botBilling.getActiveBotCount(TENANT_ID)).toBe(1);

    const result = await runRuntimeDeductions({
      ledger,
      getActiveBotCount: (tid) => botBilling.getActiveBotCount(tid),
      onSuspend: (tid) => {
        botBilling.suspendAllForTenant(tid);
      },
    });

    expect(result.suspended).toContain(TENANT_ID);

    // After suspension, bot should be suspended
    const botInfo = botBilling.getBotBilling(BOT_ID);
    expect(botInfo!.billingState).toBe("suspended");
  });

  // =========================================================================
  // TEST 5: Bot reactivation after credit purchase
  // =========================================================================

  it("suspended bot reactivated after credit purchase", () => {
    // Setup: grant minimal credits, register bot, exhaust balance, suspend
    ledger.credit(TENANT_ID, 1, "promo", "tiny grant");
    botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);
    ledger.debit(TENANT_ID, 1, "bot_runtime", "exhaust balance");
    botBilling.suspendAllForTenant(TENANT_ID);

    expect(botBilling.getBotBilling(BOT_ID)!.billingState).toBe("suspended");
    expect(ledger.balance(TENANT_ID)).toBe(0);

    // Simulate credit purchase (what the Stripe webhook handler does)
    ledger.credit(TENANT_ID, 1000, "purchase", "Stripe credit purchase");
    const reactivated = botBilling.checkReactivation(TENANT_ID, ledger);

    expect(reactivated).toContain(BOT_ID);
    expect(botBilling.getBotBilling(BOT_ID)!.billingState).toBe("active");
    expect(ledger.balance(TENANT_ID)).toBe(1000);
  });
});
