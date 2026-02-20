import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/index.js";
import { initStripeSchema } from "./schema.js";
import { createSetupIntent } from "./setup-intent.js";
import { TenantCustomerStore } from "./tenant-store.js";

function setupDb() {
  const sqlite = new BetterSqlite3(":memory:");
  initStripeSchema(sqlite);
  const db = createDb(sqlite);
  return { sqlite, db };
}

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
  it("calls stripe.setupIntents.create with correct customer ID", async () => {
    const { db } = setupDb();
    const store = new TenantCustomerStore(db);
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

    const stripe = mockStripe();
    const result = await createSetupIntent(stripe, store, { tenant: "t-1" });

    expect(result.client_secret).toBe("seti_test_123_secret_abc");
    expect(stripe.setupIntents.create).toHaveBeenCalledWith({
      customer: "cus_abc123",
      payment_method_types: ["card"],
      metadata: { wopr_tenant: "t-1" },
    });
  });

  it("throws when tenant has no Stripe customer mapping", async () => {
    const { db } = setupDb();
    const store = new TenantCustomerStore(db);
    const stripe = mockStripe();

    await expect(createSetupIntent(stripe, store, { tenant: "t-unknown" })).rejects.toThrow(
      "No Stripe customer found for tenant: t-unknown",
    );
  });

  it("passes payment_method_types: ['card'] and metadata", async () => {
    const { db } = setupDb();
    const store = new TenantCustomerStore(db);
    store.upsert({ tenant: "t-2", stripeCustomerId: "cus_def456" });

    const setupIntentCreate = vi.fn().mockResolvedValue({
      id: "seti_test_456",
      client_secret: "seti_test_456_secret_xyz",
    });
    const stripe = mockStripe({ setupIntentCreate });

    await createSetupIntent(stripe, store, { tenant: "t-2" });

    const callArgs = setupIntentCreate.mock.calls[0][0];
    expect(callArgs.payment_method_types).toEqual(["card"]);
    expect(callArgs.metadata).toEqual({ wopr_tenant: "t-2" });
  });
});
