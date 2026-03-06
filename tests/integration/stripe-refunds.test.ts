import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { Credit } from "../../src/monetization/credit.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { DrizzleWebhookSeenRepository } from "../../src/monetization/drizzle-webhook-seen-repository.js";
import { TenantCustomerRepository } from "../../src/monetization/stripe/tenant-store.js";
import { handleWebhookEvent, type WebhookDeps } from "../../src/monetization/stripe/webhook.js";
import { createTestDb } from "../../src/test/db.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("Stripe refund flow — credit deduction and ledger consistency", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let tenantRepo: TenantCustomerRepository;
  let creditLedger: CreditLedger;
  let replayGuard: DrizzleWebhookSeenRepository;
  let deps: WebhookDeps;

  let TENANT_ID: string;
  let CUSTOMER_ID: string;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());

    TENANT_ID = `refund-test-${randomUUID().slice(0, 8)}`;
    CUSTOMER_ID = `cus_${randomUUID().slice(0, 14)}`;

    tenantRepo = new TenantCustomerRepository(db);
    creditLedger = new CreditLedger(db);
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
  }): Stripe.Event {
    return {
      id: opts.eventId ?? `evt_${randomUUID()}`,
      type: "charge.refunded",
      data: {
        object: {
          id: opts.chargeId ?? `ch_${randomUUID()}`,
          customer: opts.customerId ?? CUSTOMER_ID,
          amount_refunded: opts.amountRefunded,
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
    expect(history[0].type).toBe("refund");
    expect(history[0].amount.toCents()).toBe(-5000);
    expect(history[0].balanceAfter.isZero()).toBe(true);
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
    expect(history[0].amount.toCents()).toBe(-2000);
    expect(history[0].balanceAfter.equals(Credit.fromCents(3000))).toBe(true);
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
    const refundTx = allHistory.find((tx) => tx.type === "refund");
    expect(refundTx).toBeDefined();
    expect(refundTx!.amount.toCents()).toBe(-5000);
    expect(refundTx!.balanceAfter.equals(Credit.fromCents(-3000))).toBe(true);
  });

  it("double refund on same charge ID is idempotent — no double deduction", async () => {
    await grantCredits(5000);

    const chargeId = `ch_${randomUUID()}`;
    const event = buildChargeRefundedEvent({ chargeId, amountRefunded: 5000 });

    const result1 = await handleWebhookEvent(deps, event);
    expect(result1.handled).toBe(true);
    expect(result1.debitedCents).toBe(5000);

    const balanceAfterFirst = await creditLedger.balance(TENANT_ID);
    expect(balanceAfterFirst.isZero()).toBe(true);

    const event2 = buildChargeRefundedEvent({
      chargeId,
      eventId: `evt_${randomUUID()}`,
      amountRefunded: 5000,
    });
    const result2 = await handleWebhookEvent(deps, event2);

    expect(result2.handled).toBe(true);
    expect(result2.debitedCents).toBe(0);

    const balanceAfterSecond = await creditLedger.balance(TENANT_ID);
    expect(balanceAfterSecond.isZero()).toBe(true);

    const refundHistory = await creditLedger.history(TENANT_ID, { type: "refund" });
    expect(refundHistory).toHaveLength(1);
  });
});
