import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { detachAllPaymentMethods, detachPaymentMethod } from "./payment-methods.js";
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

// TOP OF FILE - shared across ALL describes
let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("detachPaymentMethod", () => {
  let store: TenantCustomerStore;

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new TenantCustomerStore(db);
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

describe("detachAllPaymentMethods", () => {
  let store: TenantCustomerStore;

  beforeEach(async () => {
    await truncateAllTables(pool);
    store = new TenantCustomerStore(db);
  });

  it("returns 0 when tenant has no Stripe customer mapping", async () => {
    const stripe = {
      customers: { listPaymentMethods: vi.fn() },
      paymentMethods: { detach: vi.fn() },
    } as unknown as Stripe;

    const result = await detachAllPaymentMethods(stripe, store, "t-unknown");
    expect(result).toBe(0);
    expect(stripe.customers.listPaymentMethods).not.toHaveBeenCalled();
  });

  it("detaches all payment methods on a single page", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc" });

    const listPaymentMethods = vi.fn().mockResolvedValue({
      data: [{ id: "pm_1" }, { id: "pm_2" }],
      has_more: false,
    });
    const detach = vi.fn().mockResolvedValue({});
    const stripe = {
      customers: { listPaymentMethods },
      paymentMethods: { detach },
    } as unknown as Stripe;

    const result = await detachAllPaymentMethods(stripe, store, "t-1");
    expect(result).toBe(2);
    expect(detach).toHaveBeenCalledWith("pm_1");
    expect(detach).toHaveBeenCalledWith("pm_2");
    expect(listPaymentMethods).toHaveBeenCalledTimes(1);
  });

  it("paginates when has_more is true", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc" });

    const listPaymentMethods = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "pm_1" }, { id: "pm_2" }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "pm_3" }],
        has_more: false,
      });
    const detach = vi.fn().mockResolvedValue({});
    const stripe = {
      customers: { listPaymentMethods },
      paymentMethods: { detach },
    } as unknown as Stripe;

    const result = await detachAllPaymentMethods(stripe, store, "t-1");
    expect(result).toBe(3);
    expect(listPaymentMethods).toHaveBeenCalledTimes(2);
    expect(listPaymentMethods).toHaveBeenNthCalledWith(2, "cus_abc", { limit: 100, starting_after: "pm_2" });
    expect(detach).toHaveBeenCalledWith("pm_1");
    expect(detach).toHaveBeenCalledWith("pm_2");
    expect(detach).toHaveBeenCalledWith("pm_3");
  });
});
