import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createPortalSession } from "./portal.js";
import type { TenantCustomerStore } from "./tenant-store.js";

describe("createPortalSession", () => {
  function mockStripe(portalResult: unknown = { url: "https://billing.stripe.com/session_xyz" }) {
    return {
      billingPortal: {
        sessions: {
          create: vi.fn().mockResolvedValue(portalResult),
        },
      },
    } as unknown as Stripe;
  }

  function mockTenantStore(mapping: { processor_customer_id: string } | null = null) {
    return {
      getByTenant: vi.fn().mockReturnValue(mapping),
    } as unknown as TenantCustomerStore;
  }

  it("creates a portal session for an existing customer", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore({ processor_customer_id: "cus_abc" });

    const session = await createPortalSession(stripe, store, {
      tenant: "t-1",
      returnUrl: "https://example.com/billing",
    });

    expect(session.url).toBe("https://billing.stripe.com/session_xyz");
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_abc",
      return_url: "https://example.com/billing",
    });
  });

  it("throws when no Stripe customer mapping exists", async () => {
    const stripe = mockStripe();
    const store = mockTenantStore(null);

    await expect(
      createPortalSession(stripe, store, {
        tenant: "unknown-tenant",
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("No Stripe customer found for tenant: unknown-tenant");
  });

  it("propagates Stripe API errors", async () => {
    const stripe = mockStripe();
    (stripe.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Portal API error"));
    const store = mockTenantStore({ processor_customer_id: "cus_abc" });

    await expect(
      createPortalSession(stripe, store, {
        tenant: "t-1",
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("Portal API error");
  });
});
