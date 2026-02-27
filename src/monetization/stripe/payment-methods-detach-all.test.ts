import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { detachAllPaymentMethods } from "./payment-methods.js";
import type { ITenantCustomerStore } from "./tenant-store.js";

function mockStripe(paymentMethods: Array<{ id: string }> = []) {
  return {
    customers: {
      listPaymentMethods: vi.fn().mockResolvedValue({ data: paymentMethods }),
    },
    paymentMethods: {
      detach: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Stripe;
}

function mockTenantStore(customerId: string | null = "cus_123") {
  return {
    getByTenant: vi.fn().mockResolvedValue(customerId ? { tenant: "t1", processor_customer_id: customerId } : null),
  } as unknown as ITenantCustomerStore;
}

describe("detachAllPaymentMethods", () => {
  it("detaches all payment methods for a tenant", async () => {
    const stripe = mockStripe([{ id: "pm_1" }, { id: "pm_2" }]);
    const tenantStore = mockTenantStore();

    const count = await detachAllPaymentMethods(stripe, tenantStore, "t1");

    expect(count).toBe(2);
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_1");
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_2");
  });

  it("returns 0 when tenant has no Stripe customer", async () => {
    const stripe = mockStripe();
    const tenantStore = mockTenantStore(null);

    const count = await detachAllPaymentMethods(stripe, tenantStore, "t1");

    expect(count).toBe(0);
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });

  it("returns 0 when tenant has no payment methods", async () => {
    const stripe = mockStripe([]);
    const tenantStore = mockTenantStore();

    const count = await detachAllPaymentMethods(stripe, tenantStore, "t1");

    expect(count).toBe(0);
  });
});
