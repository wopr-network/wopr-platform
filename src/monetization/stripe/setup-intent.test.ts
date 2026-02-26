import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../test/db.js";
import { createSetupIntent } from "./setup-intent.js";
import { TenantCustomerStore } from "./tenant-store.js";

function mockStripe(overrides: { setupIntentCreate?: ReturnType<typeof vi.fn> } = {}) {
  return {
    setupIntents: {
      create:
        overrides.setupIntentCreate ??
        vi.fn().mockResolvedValue({
          id: "seti_test_123",
          client_secret: "seti_test_123_secret_abc",
        }),
    },
  } as unknown as Stripe;
}

describe("createSetupIntent", () => {
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

  it("calls stripe.setupIntents.create with correct customer ID", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const stripe = mockStripe();
    const result = await createSetupIntent(stripe, store, { tenant: "t-1" });

    expect(result.client_secret).toBe("seti_test_123_secret_abc");
    expect(stripe.setupIntents.create).toHaveBeenCalledWith({
      customer: "cus_abc123",
      metadata: { wopr_tenant: "t-1" },
    });
  });

  it("throws when tenant has no Stripe customer mapping", async () => {
    const stripe = mockStripe();

    await expect(createSetupIntent(stripe, store, { tenant: "t-unknown" })).rejects.toThrow(
      "No Stripe customer found for tenant: t-unknown",
    );
  });

  it("omits payment_method_types to allow dynamic payment methods", async () => {
    await store.upsert({ tenant: "t-2", processorCustomerId: "cus_def456" });

    const setupIntentCreate = vi.fn().mockResolvedValue({
      id: "seti_test_456",
      client_secret: "seti_test_456_secret_xyz",
    });
    const stripe = mockStripe({ setupIntentCreate });

    await createSetupIntent(stripe, store, { tenant: "t-2" });

    const callArgs = setupIntentCreate.mock.calls[0][0];
    expect(callArgs.payment_method_types).toBeUndefined();
    expect(callArgs.metadata).toEqual({ wopr_tenant: "t-2" });
  });
});
