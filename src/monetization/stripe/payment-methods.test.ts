import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/index.js";
import { detachPaymentMethod } from "./payment-methods.js";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";

function setupDb() {
  const sqlite = new BetterSqlite3(":memory:");
  initStripeSchema(sqlite);
  const db = createDb(sqlite);
  return { sqlite, db };
}

function mockStripe(
  overrides: { paymentMethodRetrieve?: ReturnType<typeof vi.fn>; paymentMethodDetach?: ReturnType<typeof vi.fn> } = {},
) {
  return {
    paymentMethods: {
      retrieve:
        overrides.paymentMethodRetrieve ??
        vi.fn().mockResolvedValue({
          id: "pm_test_123",
          customer: "cus_abc123",
        }),
      detach: overrides.paymentMethodDetach ?? vi.fn().mockResolvedValue({ id: "pm_test_123" }),
    },
  } as unknown as Stripe;
}

describe("detachPaymentMethod", () => {
  it("calls stripe.paymentMethods.detach with the correct ID", async () => {
    const { db } = setupDb();
    const store = new TenantCustomerStore(db);
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

    const stripe = mockStripe();
    await detachPaymentMethod(stripe, store, {
      tenant: "t-1",
      paymentMethodId: "pm_test_123",
    });

    expect(stripe.paymentMethods.retrieve).toHaveBeenCalledWith("pm_test_123");
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_test_123");
  });

  it("throws when tenant has no Stripe customer mapping", async () => {
    const { db } = setupDb();
    const store = new TenantCustomerStore(db);
    const stripe = mockStripe();

    await expect(
      detachPaymentMethod(stripe, store, {
        tenant: "t-unknown",
        paymentMethodId: "pm_test_123",
      }),
    ).rejects.toThrow("No Stripe customer found for tenant: t-unknown");
  });

  it("throws when payment method belongs to a different customer (cross-tenant guard)", async () => {
    const { db } = setupDb();
    const store = new TenantCustomerStore(db);
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

    const paymentMethodRetrieve = vi.fn().mockResolvedValue({
      id: "pm_other",
      customer: "cus_other_customer",
    });
    const stripe = mockStripe({ paymentMethodRetrieve });

    await expect(
      detachPaymentMethod(stripe, store, {
        tenant: "t-1",
        paymentMethodId: "pm_other",
      }),
    ).rejects.toThrow("Payment method does not belong to this tenant");

    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });
});
