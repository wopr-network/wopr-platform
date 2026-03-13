import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { Credit } from "@wopr-network/platform-core";
import { DrizzleLedger } from "@wopr-network/platform-core";
import { DrizzleWebhookSeenRepository, TenantCustomerRepository } from "@wopr-network/platform-core/billing";
import { handleWebhookEvent, type WebhookDeps } from "@wopr-network/platform-core/monetization/stripe/webhook";
import { createTestDb } from "@wopr-network/platform-core/test/db";

// Unit tests for the charge.refunded webhook handler.
// Uses fabricated Stripe.Event objects to test handler logic in isolation.
// For real Stripe test-mode integration, see tests/e2e/ (requires STRIPE_SECRET_KEY=sk_test_...).

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("Stripe refund flow — credit deduction and ledger consistency", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let tenantRepo: TenantCustomerRepository;
  let creditLedger: DrizzleLedger;
  let replayGuard: DrizzleWebhookSeenRepository;
  let deps: WebhookDeps;

  let TENANT_ID: string;
  let CUSTOMER_ID: string;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());

    TENANT_ID = `refund-test-${randomUUID().slice(0, 8)}`;
    CUSTOMER_ID = `cus_${randomUUID().slice(0, 14)}`;

    tenantRepo = new TenantCustomerRepository(db);
    creditLedger = new DrizzleLedger(db);
    replayGuard = new DrizzleWebhookSeenRepository(db);

    deps = {
      tenantRepo,
      creditLedger,
      replayGuard,
    };

    await tenantRepo.upsert({
      tenant: TENANT_ID,
      processorCustomerId: CUSTOMER_ID,
    });
  });

  afterEach(async () => {
    await pool.close();
  });

  function buildChargeRefundedEvent(opts: {
    chargeId?: string;
    eventId?: string;
    customerId?: string;
    amountRefunded: number;
    /** The incremental amount of this specific refund. Defaults to amountRefunded. */
    refundAmount?: number;
  }): Stripe.Event {
    const incrementalAmount = opts.refundAmount ?? opts.amountRefunded;
    return {
      id: opts.eventId ?? `evt_${randomUUID()}`,
      type: "charge.refunded",
      data: {
        object: {
          id: opts.chargeId ?? `ch_${randomUUID()}`,
          customer: opts.customerId ?? CUSTOMER_ID,
          amount_refunded: opts.amountRefunded,
          refunds: {
            data: [{ amount: incrementalAmount }],
          },
        },
      },
    } as unknown as Stripe.Event;
  }

  async function grantCredits(cents: number, refId?: string): Promise<void> {
    await creditLedger.credit(
      TENANT_ID,
      Credit.fromCents(cents),
      "purchase",
      "Test credit grant",
      refId ?? randomUUID(),
      "stripe",
    );
  }

  async function spendCredits(cents: number): Promise<void> {
    await creditLedger.debit(
      TENANT_ID,
      Credit.fromCents(cents),
      "bot_runtime",
      "Test usage debit",
      randomUUID(),
    );
  }

  it("full refund deducts all credits and records refund transaction", async () => {
    await grantCredits(5000);

    const balanceBefore = await creditLedger.balance(TENANT_ID);
    expect(balanceBefore.equals(Credit.fromCents(5000))).toBe(true);

    const event = buildChargeRefundedEvent({ amountRefunded: 5000 });
    const result = await handleWebhookEvent(deps, event);

    expect(result.handled).toBe(true);
    expect(result.event_type).toBe("charge.refunded");
    expect(result.tenant).toBe(TENANT_ID);
    expect(result.debitedCents).toBe(5000);

    const balanceAfter = await creditLedger.balance(TENANT_ID);
    expect(balanceAfter.isZero()).toBe(true);

    const history = await creditLedger.history(TENANT_ID, { type: "refund" });
    expect(history).toHaveLength(1);
    expect(history[0].entryType).toBe("refund");
    const refundLine1 = history[0].lines.find((l) => l.side === "debit" && l.accountCode.startsWith("2000:"));
    expect(refundLine1!.amount.toCents()).toBe(5000);
  });

  it("partial refund deducts proportional credits", async () => {
    await grantCredits(5000);

    const event = buildChargeRefundedEvent({ amountRefunded: 2000 });
    const result = await handleWebhookEvent(deps, event);

    expect(result.handled).toBe(true);
    expect(result.debitedCents).toBe(2000);

    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(3000))).toBe(true);

    const history = await creditLedger.history(TENANT_ID, { type: "refund" });
    expect(history).toHaveLength(1);
    const refundLine2 = history[0].lines.find((l) => l.side === "debit" && l.accountCode.startsWith("2000:"));
    expect(refundLine2!.amount.toCents()).toBe(2000);
  });

  it("full refund after partial spend results in negative balance", async () => {
    await grantCredits(5000);
    await spendCredits(3000);

    const balanceBefore = await creditLedger.balance(TENANT_ID);
    expect(balanceBefore.equals(Credit.fromCents(2000))).toBe(true);

    const event = buildChargeRefundedEvent({ amountRefunded: 5000 });
    const result = await handleWebhookEvent(deps, event);

    expect(result.handled).toBe(true);
    expect(result.debitedCents).toBe(5000);

    const balance = await creditLedger.balance(TENANT_ID);
    expect(balance.equals(Credit.fromCents(-3000))).toBe(true);
    expect(balance.isNegative()).toBe(true);

    const allHistory = await creditLedger.history(TENANT_ID);
    const refundTx = allHistory.find((tx) => tx.entryType === "refund");
    expect(refundTx).toBeDefined();
    // In double-entry ledger, refund debit amount is on the tenant liability line
    const refundLine = refundTx!.lines.find((l) => l.side === "debit" && l.accountCode.startsWith("2000:"));
    expect(refundLine!.amount.toCents()).toBe(5000);
  });

  it("two partial refund events with the same charge.id but different event.id both debit the ledger", async () => {
    await grantCredits(10000);

    const chargeId = `ch_${randomUUID()}`;
    // Stripe sends cumulative amount_refunded; refundAmount is the incremental amount.
    const event1 = buildChargeRefundedEvent({ chargeId, amountRefunded: 3000, refundAmount: 3000 });
    const event2 = buildChargeRefundedEvent({
      chargeId,
      eventId: `evt_${randomUUID()}`,
      amountRefunded: 5000, // cumulative: 3000 + 2000
      refundAmount: 2000,   // incremental amount of this specific refund
    });

    const result1 = await handleWebhookEvent(deps, event1);
    expect(result1.handled).toBe(true);
    expect(result1.debitedCents).toBe(3000);

    const balanceAfterFirst = await creditLedger.balance(TENANT_ID);
    expect(balanceAfterFirst.equals(Credit.fromCents(7000))).toBe(true);

    const result2 = await handleWebhookEvent(deps, event2);
    expect(result2.handled).toBe(true);
    expect(result2.debitedCents).toBe(2000);

    const balanceAfterSecond = await creditLedger.balance(TENANT_ID);
    expect(balanceAfterSecond.equals(Credit.fromCents(5000))).toBe(true);

    const refundHistory = await creditLedger.history(TENANT_ID, { type: "refund" });
    expect(refundHistory).toHaveLength(2);
  });

  it("replaying the same webhook event.id is idempotent — no double deduction", async () => {
    await grantCredits(5000);

    const chargeId = `ch_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const event = buildChargeRefundedEvent({ chargeId, eventId, amountRefunded: 5000 });

    const result1 = await handleWebhookEvent(deps, event);
    expect(result1.handled).toBe(true);
    expect(result1.debitedCents).toBe(5000);

    const balanceAfterFirst = await creditLedger.balance(TENANT_ID);
    expect(balanceAfterFirst.isZero()).toBe(true);

    // Replay the exact same event (same event.id) — replay guard intercepts it
    const result2 = await handleWebhookEvent(deps, event);
    expect(result2.handled).toBe(true);
    expect(result2.duplicate).toBe(true);

    const balanceAfterSecond = await creditLedger.balance(TENANT_ID);
    expect(balanceAfterSecond.isZero()).toBe(true);

    const refundHistory = await creditLedger.history(TENANT_ID, { type: "refund" });
    expect(refundHistory).toHaveLength(1);
  });
});
