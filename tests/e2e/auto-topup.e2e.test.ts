import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { creditAutoTopup } from "../../src/db/schema/credit-auto-topup.js";
import { Credit } from "../../src/monetization/credit.js";
import { type AutoTopupChargeDeps, chargeAutoTopup } from "../../src/monetization/credits/auto-topup-charge.js";
import { DrizzleAutoTopupEventLogRepository } from "../../src/monetization/credits/auto-topup-event-log-repository.js";
import { DrizzleAutoTopupSettingsRepository } from "../../src/monetization/credits/auto-topup-settings-repository.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { maybeTriggerUsageTopup } from "../../src/monetization/credits/auto-topup-usage.js";
import type { ITenantCustomerRepository } from "../../src/monetization/stripe/tenant-store.js";
import { createTestDb } from "../../src/test/db.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function makeFakeStripe(overrides?: { paymentIntentId?: string; shouldDecline?: boolean }) {
  const piId = overrides?.paymentIntentId ?? `pi_${randomUUID()}`;
  return {
    paymentIntents: {
      create: vi.fn().mockImplementation(async () => {
        if (overrides?.shouldDecline) {
          throw new Stripe.errors.StripeCardError({
            message: "Your card was declined.",
            type: "card_error",
            code: "card_declined",
            decline_code: "generic_decline",
          });
        }
        return { id: piId, status: "succeeded" };
      }),
    },
    customers: {
      listPaymentMethods: vi.fn().mockResolvedValue({
        data: [{ id: `pm_${randomUUID()}` }],
      }),
    },
  };
}

function makeFakeTenantRepo(tenantId: string, customerId: string): ITenantCustomerRepository {
  return {
    getByTenant: vi.fn().mockImplementation(async (tid: string) => {
      if (tid === tenantId) {
        return { tenant: tenantId, processor_customer_id: customerId };
      }
      return null;
    }),
    getByProcessorCustomerId: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    listProcessorIds: vi.fn().mockResolvedValue([]),
    setTier: vi.fn().mockResolvedValue(undefined),
    setBillingHold: vi.fn().mockResolvedValue(undefined),
    hasBillingHold: vi.fn().mockResolvedValue(false),
    getInferenceMode: vi.fn().mockResolvedValue("byok"),
    setInferenceMode: vi.fn().mockResolvedValue(undefined),
    buildCustomerIdMap: vi.fn().mockResolvedValue({}),
  } as unknown as ITenantCustomerRepository;
}

describe("E2E: Stripe auto-topup — balance depletion triggers charge and credit grant", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let settingsRepo: DrizzleAutoTopupSettingsRepository;
  let eventLogRepo: DrizzleAutoTopupEventLogRepository;
  let TENANT_ID: string;
  const CUSTOMER_ID = "cus_e2e_topup_test";

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    TENANT_ID = `e2e-topup-${randomUUID().slice(0, 8)}`;
    ledger = new CreditLedger(db);
    settingsRepo = new DrizzleAutoTopupSettingsRepository(db);
    eventLogRepo = new DrizzleAutoTopupEventLogRepository(db);
  });

  afterEach(async () => {
    await pool?.close();
  });

  it("depleted balance triggers auto-topup: Stripe PaymentIntent created, ledger credited", async () => {
    const piId = `pi_${randomUUID()}`;
    const fakeStripe = makeFakeStripe({ paymentIntentId: piId });
    const fakeTenantRepo = makeFakeTenantRepo(TENANT_ID, CUSTOMER_ID);

    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Initial purchase");
    await settingsRepo.upsert(TENANT_ID, {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(200),
      usageTopup: Credit.fromCents(1000),
    });

    await ledger.debit(TENANT_ID, Credit.fromCents(400), "adapter_usage", "heavy usage");
    const balanceBefore = await ledger.balance(TENANT_ID);
    expect(balanceBefore.toCents()).toBe(100);

    const deps: AutoTopupChargeDeps = {
      stripe: fakeStripe as unknown as Stripe,
      tenantRepo: fakeTenantRepo,
      creditLedger: ledger,
      eventLogRepo,
    };

    await maybeTriggerUsageTopup(
      {
        settingsRepo,
        creditLedger: ledger,
        chargeAutoTopup: (tid, amount, source) => chargeAutoTopup(deps, tid, amount, source),
      },
      TENANT_ID,
    );

    expect(fakeStripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    const createCall = fakeStripe.paymentIntents.create.mock.calls[0][0];
    expect(createCall.amount).toBe(1000);
    expect(createCall.currency).toBe("usd");
    expect(createCall.customer).toBe(CUSTOMER_ID);
    expect(createCall.off_session).toBe(true);
    expect(createCall.confirm).toBe(true);

    const balanceAfter = await ledger.balance(TENANT_ID);
    expect(balanceAfter.toCents()).toBe(1100);

    const events = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, TENANT_ID));
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("success");
    expect(events[0].amountCents).toBe(1000);
    expect(events[0].paymentReference).toBe(piId);

    const history = await ledger.history(TENANT_ID);
    const topupTx = history.find((tx) => tx.referenceId === piId);
    expect(topupTx).toBeDefined();
    expect(topupTx!.type).toBe("purchase");
    expect(topupTx!.fundingSource).toBe("stripe");
  });

  it("in-flight guard prevents double-charge when balance is still below threshold", async () => {
    const piId = `pi_${randomUUID()}`;
    const fakeStripe = makeFakeStripe({ paymentIntentId: piId });
    const fakeTenantRepo = makeFakeTenantRepo(TENANT_ID, CUSTOMER_ID);

    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Initial");
    await settingsRepo.upsert(TENANT_ID, {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(200),
      usageTopup: Credit.fromCents(1000),
    });

    // Balance: 100 cents (below threshold of 200) — both triggers would fire based on balance alone
    await ledger.debit(TENANT_ID, Credit.fromCents(400), "adapter_usage", "usage");

    const deps: AutoTopupChargeDeps = {
      stripe: fakeStripe as unknown as Stripe,
      tenantRepo: fakeTenantRepo,
      creditLedger: ledger,
      eventLogRepo,
    };

    // Simulate in-flight guard already held (i.e., a concurrent trigger acquired it first)
    const tryAcquireSpy = vi.spyOn(settingsRepo, "tryAcquireUsageInFlight");

    // First call: guard available — charge fires
    tryAcquireSpy.mockResolvedValueOnce(true);
    await maybeTriggerUsageTopup(
      {
        settingsRepo,
        creditLedger: ledger,
        chargeAutoTopup: (tid, amount, source) => chargeAutoTopup(deps, tid, amount, source),
      },
      TENANT_ID,
    );
    expect(fakeStripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    // Second concurrent trigger: guard already held — charge must NOT fire even though balance is still low
    tryAcquireSpy.mockResolvedValueOnce(false);
    await maybeTriggerUsageTopup(
      {
        settingsRepo,
        creditLedger: ledger,
        chargeAutoTopup: (tid, amount, source) => chargeAutoTopup(deps, tid, amount, source),
      },
      TENANT_ID,
    );
    // Still only one charge — in-flight guard blocked the second attempt
    expect(fakeStripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    tryAcquireSpy.mockRestore();
  });

  it("card declined: no credits granted, failure event recorded", async () => {
    const fakeStripe = makeFakeStripe({ shouldDecline: true });
    const fakeTenantRepo = makeFakeTenantRepo(TENANT_ID, CUSTOMER_ID);

    await ledger.credit(TENANT_ID, Credit.fromCents(500), "purchase", "Initial");
    await settingsRepo.upsert(TENANT_ID, {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(200),
      usageTopup: Credit.fromCents(1000),
    });

    await ledger.debit(TENANT_ID, Credit.fromCents(400), "adapter_usage", "usage");

    const deps: AutoTopupChargeDeps = {
      stripe: fakeStripe as unknown as Stripe,
      tenantRepo: fakeTenantRepo,
      creditLedger: ledger,
      eventLogRepo,
    };

    await maybeTriggerUsageTopup(
      {
        settingsRepo,
        creditLedger: ledger,
        chargeAutoTopup: (tid, amount, source) => chargeAutoTopup(deps, tid, amount, source),
      },
      TENANT_ID,
    );

    expect(fakeStripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    const balance = await ledger.balance(TENANT_ID);
    expect(balance.toCents()).toBe(100);

    const events = await db.select().from(creditAutoTopup).where(eq(creditAutoTopup.tenantId, TENANT_ID));
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("failed");
    expect(events[0].failureReason).toContain("Card declined");
    expect(events[0].failureReason).toContain("card_declined");

    const settings = await settingsRepo.getByTenant(TENANT_ID);
    expect(settings!.usageConsecutiveFailures).toBe(1);
  });
});
