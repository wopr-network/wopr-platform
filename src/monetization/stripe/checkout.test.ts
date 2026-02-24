import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createCreditCheckoutSession, createVpsCheckoutSession } from "./checkout.js";
import type { ITenantCustomerStore, TenantCustomerStore } from "./tenant-store.js";

describe("createCreditCheckoutSession", () => {
  function mockStripe(sessionCreateResult: unknown = { id: "cs_test", url: "https://checkout.stripe.com/cs_test" }) {
    return {
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue(sessionCreateResult),
        },
      },
    } as unknown as Stripe;
  }

  function mockTenantStore(existingMapping: { processor_customer_id: string } | null = null) {
    return {
      getByTenant: vi.fn().mockReturnValue(existingMapping),
    } as unknown as TenantCustomerStore;
  }

  it("creates a payment-mode checkout session", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore();

    const session = await createCreditCheckoutSession(stripe, store, {
      tenant: "t-1",
      priceId: "price_abc",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(session.id).toBe("cs_test");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [{ price: "price_abc", quantity: 1 }],
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        client_reference_id: "t-1",
        metadata: expect.objectContaining({ wopr_tenant: "t-1" }),
      }),
    );
  });

  it("reuses existing Stripe customer when available", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore({ processor_customer_id: "cus_existing" });

    await createCreditCheckoutSession(stripe, store, {
      tenant: "t-1",
      priceId: "price_abc",
      successUrl: "https://example.com/s",
      cancelUrl: "https://example.com/c",
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_existing" }));
  });

  it("does not set customer when no existing mapping", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore(null);

    await createCreditCheckoutSession(stripe, store, {
      tenant: "t-new",
      priceId: "price_abc",
      successUrl: "https://example.com/s",
      cancelUrl: "https://example.com/c",
    });

    const callArgs = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.customer).toBeUndefined();
  });

  it("propagates Stripe API errors", async () => {
    const stripe = mockStripe();
    (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Stripe error"));
    const store = mockTenantStore();

    await expect(
      createCreditCheckoutSession(stripe, store, {
        tenant: "t-1",
        priceId: "price_abc",
        successUrl: "https://example.com/s",
        cancelUrl: "https://example.com/c",
      }),
    ).rejects.toThrow("Stripe error");
  });
});

describe("createVpsCheckoutSession", () => {
  function mockStripe(
    sessionCreateResult: unknown = { id: "cs_vps_test", url: "https://checkout.stripe.com/cs_vps_test" },
  ) {
    return {
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue(sessionCreateResult),
        },
      },
    } as unknown as Stripe;
  }

  function mockTenantStore(existingMapping: { processor_customer_id: string } | null = null) {
    return {
      getByTenant: vi.fn().mockReturnValue(existingMapping),
    } as unknown as ITenantCustomerStore;
  }

  it("creates a subscription-mode checkout session", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore();

    const session = await createVpsCheckoutSession(stripe, store, {
      tenant: "t-1",
      botId: "bot-abc",
      vpsPriceId: "price_vps_15",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(session.id).toBe("cs_vps_test");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_vps_15", quantity: 1 }],
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        client_reference_id: "t-1",
        metadata: expect.objectContaining({
          wopr_tenant: "t-1",
          wopr_bot_id: "bot-abc",
          wopr_purchase_type: "vps",
        }),
      }),
    );
  });

  it("reuses existing Stripe customer when available", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore({ processor_customer_id: "cus_existing" });

    await createVpsCheckoutSession(stripe, store, {
      tenant: "t-1",
      botId: "bot-abc",
      vpsPriceId: "price_vps_15",
      successUrl: "https://example.com/s",
      cancelUrl: "https://example.com/c",
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_existing" }));
  });

  it("does not set customer when no existing mapping", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore(null);

    await createVpsCheckoutSession(stripe, store, {
      tenant: "t-new",
      botId: "bot-xyz",
      vpsPriceId: "price_vps_15",
      successUrl: "https://example.com/s",
      cancelUrl: "https://example.com/c",
    });

    const callArgs = (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.customer).toBeUndefined();
  });

  it("propagates Stripe API errors", async () => {
    const stripe = mockStripe();
    (stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("VPS Stripe error"));
    const store = mockTenantStore();

    await expect(
      createVpsCheckoutSession(stripe, store, {
        tenant: "t-1",
        botId: "bot-abc",
        vpsPriceId: "price_vps_15",
        successUrl: "https://example.com/s",
        cancelUrl: "https://example.com/c",
      }),
    ).rejects.toThrow("VPS Stripe error");
  });
});
