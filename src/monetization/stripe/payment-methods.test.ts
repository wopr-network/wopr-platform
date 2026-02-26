import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../test/db.js";
import { detachPaymentMethod } from "./payment-methods.js";
import { TenantCustomerStore } from "./tenant-store.js";

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
  let pool: PGlite;
  let store: TenantCustomerStore;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    store = new TenantCustomerStore(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("calls stripe.paymentMethods.detach with the correct ID", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const stripe = mockStripe();
    await detachPaymentMethod(stripe, store, {
      tenant: "t-1",
      paymentMethodId: "pm_test_123",
    });

    expect(stripe.paymentMethods.retrieve).toHaveBeenCalledWith("pm_test_123");
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_test_123");
  });

  it("throws when tenant has no Stripe customer mapping", async () => {
    const stripe = mockStripe();

    await expect(
      detachPaymentMethod(stripe, store, {
        tenant: "t-unknown",
        paymentMethodId: "pm_test_123",
      }),
    ).rejects.toThrow("No Stripe customer found for tenant: t-unknown");
  });

  it("throws when payment method belongs to a different customer (cross-tenant guard)", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

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
