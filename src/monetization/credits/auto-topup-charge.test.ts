import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopup } from "../../db/schema/credit-auto-topup.js";
import { createTestDb } from "../../test/db.js";
import type { ITenantCustomerStore } from "../stripe/tenant-store.js";
import { type AutoTopupChargeDeps, chargeAutoTopup, MAX_CONSECUTIVE_FAILURES } from "./auto-topup-charge.js";
import { DrizzleAutoTopupEventLogRepository } from "./auto-topup-event-log-repository.js";
import { CreditLedger } from "./credit-ledger.js";

function mockStripe(overrides?: { paymentIntentId?: string; shouldFail?: boolean; failMessage?: string }) {
  const piId = overrides?.paymentIntentId ?? `pi_${crypto.randomUUID()}`;
  return {
    paymentIntents: {
      create: vi.fn().mockImplementation(async () => {
        if (overrides?.shouldFail) throw new Error(overrides.failMessage ?? "card_declined");
        return { id: piId, status: "succeeded" };
      }),
    },
    customers: {
      listPaymentMethods: vi.fn().mockResolvedValue({ data: [{ id: "pm_123" }] }),
    },
  };
}

function mockTenantStore(stripeCustomerId = "cus_123") {
  return {
    getByTenant: vi.fn().mockResolvedValue({ tenant: "t1", processor_customer_id: stripeCustomerId }),
  };
}

describe("chargeAutoTopup", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("charges Stripe and credits ledger on success", async () => {
    const stripe = mockStripe();
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(true);
    expect(result.paymentReference).toBeDefined();
    expect(await ledger.balance("t1")).toBe(500);
    const history = await ledger.history("t1");
    expect(history[0].type).toBe("purchase");
    expect(history[0].fundingSource).toBe("stripe");
  });

  it("writes success event to credit_auto_topup log", async () => {
    const stripe = mockStripe();
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    const events = await db
      .select()
      .from(creditAutoTopup)
      .where((await import("drizzle-orm")).eq(creditAutoTopup.tenantId, "t1"));
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("success");
    expect(events[0].amountCents).toBe(500);
  });

  it("returns failure result and writes failure event on Stripe error", async () => {
    const stripe = mockStripe({ shouldFail: true, failMessage: "card_declined" });
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(false);
    expect(result.error).toContain("card_declined");
    expect(await ledger.balance("t1")).toBe(0);
    const events = await db
      .select()
      .from(creditAutoTopup)
      .where((await import("drizzle-orm")).eq(creditAutoTopup.tenantId, "t1"));
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("failed");
  });

  it("returns failure when tenant has no Stripe customer", async () => {
    const stripe = mockStripe();
    const tenantStore = { getByTenant: vi.fn().mockResolvedValue(null) };
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No Stripe customer");
  });

  it("returns failure when tenant has no payment methods", async () => {
    const stripe = mockStripe();
    stripe.customers.listPaymentMethods = vi.fn().mockResolvedValue({ data: [] });
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No payment method");
  });

  it("is idempotent -- referenceId already credited means hasReferenceId returns true", async () => {
    const piId = `pi_${crypto.randomUUID()}`;
    const stripe = mockStripe({ paymentIntentId: piId });
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");
    expect(await ledger.balance("t1")).toBe(500);
    expect(await ledger.hasReferenceId(piId)).toBe(true);
  });

  it("exports MAX_CONSECUTIVE_FAILURES as 3", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
  });
});
