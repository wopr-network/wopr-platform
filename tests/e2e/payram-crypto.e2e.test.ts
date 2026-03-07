/**
 * E2E tests for PayRam crypto checkout and webhook flow (WOP-1756).
 *
 * Tests the full lifecycle: checkout creation -> webhook processing -> credit grant.
 * Uses PGlite for real DB state and DrizzleWebhookSeenRepository for real replay guard.
 * PayRam SDK (payments.initiatePayment) is the only thing mocked — it calls an external HTTP API.
 * Everything else — DrizzlePayRamChargeRepository, CreditLedger, handlePayRamWebhook — runs
 * against real PGlite, exercising the real business logic end-to-end.
 */
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Payram } from "payram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { Credit } from "../../src/monetization/credit.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { DrizzleWebhookSeenRepository } from "../../src/monetization/drizzle-webhook-seen-repository.js";
import { DrizzlePayRamChargeRepository } from "../../src/monetization/payram/charge-store.js";
import { createPayRamCheckout } from "../../src/monetization/payram/checkout.js";
import type { PayRamWebhookPayload } from "../../src/monetization/payram/types.js";
import { handlePayRamWebhook } from "../../src/monetization/payram/webhook.js";
import { createTestDb } from "../../src/test/db.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPayram(initiatePayment: ReturnType<typeof vi.fn>): Payram {
  const stub: Pick<Payram, "payments"> = {
    payments: { initiatePayment } as Payram["payments"],
  };
  return stub as Payram;
}

function makeWebhookPayload(overrides: Partial<PayRamWebhookPayload> = {}): PayRamWebhookPayload {
  return {
    reference_id: "ref-e2e-default",
    status: "FILLED",
    amount: "25.00",
    currency: "USDC",
    filled_amount: "25.00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: PayRam crypto checkout and webhook flow", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let chargeStore: DrizzlePayRamChargeRepository;
  let creditLedger: CreditLedger;
  let replayGuard: DrizzleWebhookSeenRepository;
  let TENANT_ID: string;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    TENANT_ID = `e2e-payram-${randomUUID().slice(0, 8)}`;
    chargeStore = new DrizzlePayRamChargeRepository(db);
    creditLedger = new CreditLedger(db);
    replayGuard = new DrizzleWebhookSeenRepository(db);
  });

  afterEach(async () => {
    if (pool) await pool.close();
  });

  // ------------------------------------------------------------------
  // TEST 1: Checkout creation stores charge and returns session URL
  // ------------------------------------------------------------------

  it("checkout creation stores charge with OPEN status and returns payment URL", async () => {
    const refId = `ref-checkout-${randomUUID().slice(0, 8)}`;
    const initiatePayment = vi.fn().mockResolvedValue({
      reference_id: refId,
      url: `https://payram.example.com/pay/${refId}`,
    });
    const mockPayram = createMockPayram(initiatePayment);

    const result = await createPayRamCheckout(mockPayram, chargeStore, {
      tenant: TENANT_ID,
      amountUsd: 25,
    });

    // Verify returned session URL and reference ID
    expect(result.referenceId).toBe(refId);
    expect(result.url).toBe(`https://payram.example.com/pay/${refId}`);

    // Verify charge stored in DB with OPEN status and correct amount
    const charge = await chargeStore.getByReferenceId(refId);
    expect(charge).not.toBeNull();
    expect(charge!.tenantId).toBe(TENANT_ID);
    expect(charge!.amountUsdCents).toBe(2500); // $25 = 2500 cents
    expect(charge!.status).toBe("OPEN");
    expect(charge!.creditedAt).toBeNull();

    // Verify no credits granted yet (payment not completed)
    expect((await creditLedger.balance(TENANT_ID)).isZero()).toBe(true);

    // Verify SDK called with correct params
    expect(initiatePayment).toHaveBeenCalledWith({
      customerEmail: expect.stringContaining(TENANT_ID),
      customerId: TENANT_ID,
      amountInUSD: 25,
    });
  });

  // ------------------------------------------------------------------
  // TEST 2: FILLED webhook grants credits and updates charge status
  // ------------------------------------------------------------------

  it("FILLED webhook grants credits, updates charge status, and marks creditedAt", async () => {
    const refId = `ref-filled-${randomUUID().slice(0, 8)}`;

    // Pre-seed charge record (simulates prior checkout)
    await chargeStore.create(refId, TENANT_ID, 2500); // $25

    // Verify zero balance before webhook
    expect((await creditLedger.balance(TENANT_ID)).isZero()).toBe(true);

    const result = await handlePayRamWebhook(
      { chargeStore, creditLedger, replayGuard },
      makeWebhookPayload({ reference_id: refId, status: "FILLED" }),
    );

    expect(result.handled).toBe(true);
    expect(result.status).toBe("FILLED");
    expect(result.tenant).toBe(TENANT_ID);
    expect(result.creditedCents).toBe(2500);
    expect(result.duplicate).toBeUndefined();

    // Verify credits granted
    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(2500))).toBe(true);

    // Verify charge record updated in DB
    const charge = await chargeStore.getByReferenceId(refId);
    expect(charge!.status).toBe("FILLED");
    expect(charge!.currency).toBe("USDC");
    expect(charge!.creditedAt).not.toBeNull();
  });

  // ------------------------------------------------------------------
  // TEST 3: Replay guard prevents double-crediting on duplicate webhook
  // ------------------------------------------------------------------

  it("duplicate FILLED webhook is blocked by replay guard — credits granted only once", async () => {
    const refId = `ref-dedup-${randomUUID().slice(0, 8)}`;

    await chargeStore.create(refId, TENANT_ID, 1000); // $10

    // First webhook — should credit
    const first = await handlePayRamWebhook(
      { chargeStore, creditLedger, replayGuard },
      makeWebhookPayload({ reference_id: refId, status: "FILLED", amount: "10.00", filled_amount: "10.00" }),
    );
    expect(first.handled).toBe(true);
    expect(first.duplicate).toBeUndefined();
    expect(first.creditedCents).toBe(1000);

    // Second identical webhook — replay guard blocks it
    const second = await handlePayRamWebhook(
      { chargeStore, creditLedger, replayGuard },
      makeWebhookPayload({ reference_id: refId, status: "FILLED", amount: "10.00", filled_amount: "10.00" }),
    );
    expect(second.handled).toBe(true);
    expect(second.duplicate).toBe(true);

    // Balance unchanged — only credited once
    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(1000))).toBe(true);
  });

  // ------------------------------------------------------------------
  // TEST 4: CANCELLED webhook updates charge status but grants no credits
  // ------------------------------------------------------------------

  it("CANCELLED webhook updates charge status but does not grant credits", async () => {
    const refId = `ref-cancelled-${randomUUID().slice(0, 8)}`;

    await chargeStore.create(refId, TENANT_ID, 1500); // $15

    const result = await handlePayRamWebhook(
      { chargeStore, creditLedger, replayGuard },
      makeWebhookPayload({
        reference_id: refId,
        status: "CANCELLED",
        amount: "0",
        filled_amount: "0",
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.status).toBe("CANCELLED");
    expect(result.tenant).toBe(TENANT_ID);
    expect(result.creditedCents).toBeUndefined();

    // Charge status updated, never credited
    const charge = await chargeStore.getByReferenceId(refId);
    expect(charge!.status).toBe("CANCELLED");
    expect(charge!.creditedAt).toBeNull();

    // Zero balance — no credits granted for cancelled payment
    expect((await creditLedger.balance(TENANT_ID)).isZero()).toBe(true);
  });

  // ------------------------------------------------------------------
  // TEST 5: OVER_FILLED webhook credits original amount, not overpaid amount
  // ------------------------------------------------------------------

  it("OVER_FILLED webhook credits original requested amount — overpayment stays in wallet", async () => {
    const refId = `ref-overfilled-${randomUUID().slice(0, 8)}`;

    // Charge was for $20 (2000 cents), but customer sent more crypto
    await chargeStore.create(refId, TENANT_ID, 2000);

    const result = await handlePayRamWebhook(
      { chargeStore, creditLedger, replayGuard },
      makeWebhookPayload({
        reference_id: refId,
        status: "OVER_FILLED",
        amount: "22.50",
        currency: "USDC",
        filled_amount: "22.50",
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.status).toBe("OVER_FILLED");
    expect(result.tenant).toBe(TENANT_ID);
    // Credits the original requested amount ($20 = 2000 cents), not the overpaid amount
    expect(result.creditedCents).toBe(2000);

    // Verify charge record updated
    const charge = await chargeStore.getByReferenceId(refId);
    expect(charge!.status).toBe("OVER_FILLED");
    expect(charge!.creditedAt).not.toBeNull();

    // Balance reflects original amount, not the overpaid crypto amount
    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(2000))).toBe(true);
  });

  // ------------------------------------------------------------------
  // TEST 6: Unknown reference_id returns handled:false — no crash
  // ------------------------------------------------------------------

  it("FILLED webhook with unknown reference_id returns handled:false and grants no credits", async () => {
    const result = await handlePayRamWebhook(
      { chargeStore, creditLedger, replayGuard },
      makeWebhookPayload({ reference_id: "ref-does-not-exist", status: "FILLED" }),
    );

    expect(result.handled).toBe(false);
    expect(result.status).toBe("FILLED");
    expect(result.tenant).toBeUndefined();
    expect(result.creditedCents).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // TEST 7: Full checkout -> webhook cycle with real DB state
  // ------------------------------------------------------------------

  it("full cycle: checkout creation followed by FILLED webhook grants correct credits", async () => {
    const refId = `ref-cycle-${randomUUID().slice(0, 8)}`;
    const initiatePayment = vi.fn().mockResolvedValue({
      reference_id: refId,
      url: `https://payram.example.com/pay/${refId}`,
    });

    // Step 1: Create checkout (stores OPEN charge)
    const checkoutResult = await createPayRamCheckout(createMockPayram(initiatePayment), chargeStore, {
      tenant: TENANT_ID,
      amountUsd: 50,
    });
    expect(checkoutResult.referenceId).toBe(refId);

    // Verify no credits yet
    expect((await creditLedger.balance(TENANT_ID)).isZero()).toBe(true);

    // Step 2: PayRam sends FILLED webhook
    const webhookResult = await handlePayRamWebhook(
      { chargeStore, creditLedger, replayGuard },
      makeWebhookPayload({
        reference_id: refId,
        status: "FILLED",
        amount: "50.00",
        currency: "USDC",
        filled_amount: "50.00",
      }),
    );

    expect(webhookResult.handled).toBe(true);
    expect(webhookResult.creditedCents).toBe(5000); // $50 = 5000 cents
    expect(webhookResult.tenant).toBe(TENANT_ID);

    // Verify final balance
    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(5000))).toBe(true);

    // Verify charge fully updated
    const charge = await chargeStore.getByReferenceId(refId);
    expect(charge!.status).toBe("FILLED");
    expect(charge!.creditedAt).not.toBeNull();
  });
});
