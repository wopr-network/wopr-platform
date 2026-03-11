import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleSigPenaltyRepository } from "../../src/api/drizzle-sig-penalty-repository.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { DrizzleBotInstanceRepository } from "../../src/fleet/drizzle-bot-instance-repository.js";
import { Credit } from "@wopr-network/platform-core";
import { BotBilling } from "../../src/monetization/credits/bot-billing.js";
import { CreditLedger } from "@wopr-network/platform-core";
import { DrizzleWebhookSeenRepository } from "../../src/monetization/drizzle-webhook-seen-repository.js";
import { MeterAggregator } from "../../src/monetization/metering/aggregator.js";
import { DrizzleUsageSummaryRepository } from "../../src/monetization/metering/drizzle-usage-summary-repository.js";
import { StripePaymentProcessor } from "../../src/monetization/stripe/stripe-payment-processor.js";
import { TenantCustomerRepository } from "../../src/monetization/stripe/tenant-store.js";
import { DrizzleAffiliateRepository } from "../../src/monetization/affiliate/drizzle-affiliate-repository.js";
import { createTestDb } from "../../src/test/db.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const TEST_TOKEN = "test-webhook-token";

const WEBHOOK_SECRET = "whsec_test_e2e_secret_for_stripe_webhook";

const stripe = new Stripe("sk_test_fake_key_not_used");

describe("E2E: Stripe webhook -> credit grant -> bot reactivation", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let tenantRepo: TenantCustomerRepository;
  let creditLedger: CreditLedger;
  let botBilling: BotBilling;
  let replayGuard: DrizzleWebhookSeenRepository;
  let sigPenaltyRepo: DrizzleSigPenaltyRepository;
  let processor: StripePaymentProcessor;

  // Unique IDs per test to avoid collisions
  let TENANT_ID: string;
  let BOT_ID: string;
  const BOT_NAME = "e2e-suspended-bot";

  beforeEach(async () => {
    vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);
    ({ db, pool } = await createTestDb());

    TENANT_ID = `e2e-stripe-wh-${randomUUID().slice(0, 8)}`;
    BOT_ID = randomUUID();

    tenantRepo = new TenantCustomerRepository(db);
    creditLedger = new CreditLedger(db);
    botBilling = new BotBilling(new DrizzleBotInstanceRepository(db));
    replayGuard = new DrizzleWebhookSeenRepository(db);
    sigPenaltyRepo = new DrizzleSigPenaltyRepository(db);

    processor = new StripePaymentProcessor({
      stripe,
      tenantRepo,
      webhookSecret: WEBHOOK_SECRET,
      creditLedger,
      botBilling,
      replayGuard,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.close();
  });

  function buildSignedWebhook(payload: Record<string, unknown>): {
    body: string;
    signature: string;
  } {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: WEBHOOK_SECRET,
      timestamp,
    });
    return { body, signature };
  }

  function buildCheckoutEvent(
    overrides: {
      eventId?: string;
      tenant?: string;
      amountTotal?: number;
      sessionId?: string;
      customerId?: string;
    } = {},
  ): Record<string, unknown> {
    return {
      id: overrides.eventId ?? `evt_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: overrides.sessionId ?? `cs_${randomUUID()}`,
          client_reference_id: overrides.tenant ?? TENANT_ID,
          customer: overrides.customerId ?? `cus_${randomUUID()}`,
          amount_total: overrides.amountTotal ?? 5000,
          metadata: {},
        },
      },
    };
  }

  async function postWebhook(body: string, signature: string) {
    return processor.handleWebhook(Buffer.from(body), signature);
  }

  // ------------------------------------------------------------------
  // TEST 1: Happy path — webhook grants credits, reactivates suspended bot
  // ------------------------------------------------------------------

  it("checkout.session.completed grants credits and reactivates suspended bot", async () => {
    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);
    await botBilling.suspendBot(BOT_ID);

    const botBefore = (await botBilling.getBotBilling(BOT_ID)) as { billingState: string };
    expect(botBefore.billingState).toBe("suspended");
    expect((await creditLedger.balance(TENANT_ID)).isZero()).toBe(true);

    const event = buildCheckoutEvent({ amountTotal: 5000 });
    const { body, signature } = buildSignedWebhook(event);

    const result = await postWebhook(body, signature);

    expect(result.handled).toBe(true);
    expect(result.eventType).toBe("checkout.session.completed");
    expect(result.tenant).toBe(TENANT_ID);
    expect(result.credited?.toCents()).toBe(5000);
    expect(result.reactivatedBots).toContain(BOT_ID);

    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(5000))).toBe(true);

    const botAfter = (await botBilling.getBotBilling(BOT_ID)) as { billingState: string };
    expect(botAfter.billingState).toBe("active");
  });

  // ------------------------------------------------------------------
  // TEST 2: Invalid signature -> error, no credits granted
  // ------------------------------------------------------------------

  it("invalid signature throws, no credits granted", async () => {
    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);

    const event = buildCheckoutEvent({ amountTotal: 5000 });
    const body = JSON.stringify(event);
    const badSignature = "t=9999999999,v1=bad_signature_value";

    await expect(postWebhook(body, badSignature)).rejects.toThrow();

    expect((await creditLedger.balance(TENANT_ID)).isZero()).toBe(true);
  });

  // ------------------------------------------------------------------
  // TEST 3: Duplicate event ID -> idempotent (replay guard)
  // ------------------------------------------------------------------

  it("duplicate event ID returns duplicate flag, no double-grant", async () => {
    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);

    const eventId = `evt_${randomUUID()}`;
    const event = buildCheckoutEvent({ eventId, amountTotal: 3000 });
    const { body, signature } = buildSignedWebhook(event);

    const first = await postWebhook(body, signature);
    expect(first.handled).toBe(true);
    expect(first.credited?.toCents()).toBe(3000);

    // Second call — replay guard catches it via event ID
    const { body: body2, signature: sig2 } = buildSignedWebhook(event);
    const second = await postWebhook(body2, sig2);
    expect(second.handled).toBe(true);
    expect(second.duplicate).toBe(true);

    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(3000))).toBe(true);
  });

  // ------------------------------------------------------------------
  // TEST 4: Missing tenant -> handled:false, no crash
  // ------------------------------------------------------------------

  it("missing tenant in metadata returns handled:false, no crash", async () => {
    const event = buildCheckoutEvent();
    (event.data as { object: Record<string, unknown> }).object.client_reference_id = null;
    (event.data as { object: { metadata: Record<string, unknown> } }).object.metadata = {};

    const { body, signature } = buildSignedWebhook(event);
    const result = await postWebhook(body, signature);

    expect(result.handled).toBe(false);
    expect(result.eventType).toBe("checkout.session.completed");
  });

  async function buildBillingApp() {
    const { billingRoutes, setBillingDeps } = await import("../../src/api/routes/billing.js");
    const { Hono } = await import("hono");

    const app = new Hono();

    const affiliateRepo = new DrizzleAffiliateRepository(db);
    const meterAggregator = new MeterAggregator(new DrizzleUsageSummaryRepository(db));

    setBillingDeps({
      processor,
      creditLedger,
      meterAggregator,
      sigPenaltyRepo,
      replayGuard,
      payramReplayGuard: replayGuard,
      affiliateRepo,
    });

    app.route("/billing", billingRoutes);
    return app;
  }

  // ------------------------------------------------------------------
  // TEST 5: Full HTTP route — POST /billing/webhook with valid signature returns 200
  // ------------------------------------------------------------------

  it("POST /billing/webhook with valid signature returns 200", async () => {
    const app = await buildBillingApp();

    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);
    await botBilling.suspendBot(BOT_ID);

    const event = buildCheckoutEvent({ amountTotal: 10000 });
    const { body, signature } = buildSignedWebhook(event);

    const res = await app.request("/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.handled).toBe(true);
    expect(json.event_type).toBe("checkout.session.completed");
    expect(json.tenant).toBe(TENANT_ID);

    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(10000))).toBe(true);

    const botAfter = (await botBilling.getBotBilling(BOT_ID)) as { billingState: string };
    expect(botAfter.billingState).toBe("active");
  });

  // ------------------------------------------------------------------
  // TEST 6: POST /billing/webhook with invalid signature returns 400
  // ------------------------------------------------------------------

  it("POST /billing/webhook with invalid signature returns 400", async () => {
    const app = await buildBillingApp();

    const event = buildCheckoutEvent();
    const body = JSON.stringify(event);

    const res = await app.request("/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=9999999999,v1=invalid",
      },
      body,
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("Invalid webhook signature");
  });

  // ------------------------------------------------------------------
  // TEST 7: POST /billing/webhook with missing signature returns 400
  // ------------------------------------------------------------------

  it("POST /billing/webhook with missing stripe-signature returns 400", async () => {
    const app = await buildBillingApp();

    const res = await app.request("/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCheckoutEvent()),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("Missing stripe-signature header");
  });
});
