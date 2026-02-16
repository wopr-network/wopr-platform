import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import type { TenantCustomerRepository } from "../../domain/repositories/tenant-customer-repository.js";
import { createPortalSession } from "./portal.js";

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

  function mockTenantRepo(mapping: { stripeCustomerId: string } | null = null) {
    return {
      getByTenant: vi.fn().mockResolvedValue(mapping),
    } as unknown as TenantCustomerRepository;
  }

  it("creates a portal session for an existing customer", async () => {
    const stripe = mockStripe();
    const repo = mockTenantRepo({ stripeCustomerId: "cus_abc" });

    const session = await createPortalSession(stripe, repo, {
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
    const repo = mockTenantRepo(null);

    await expect(
      createPortalSession(stripe, repo, {
        tenant: "unknown-tenant",
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("No Stripe customer found for tenant: unknown-tenant");
  });

  it("propagates Stripe API errors", async () => {
    const stripe = mockStripe();
    (stripe.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Portal API error"));
    const repo = mockTenantRepo({ stripeCustomerId: "cus_abc" });

    await expect(
      createPortalSession(stripe, repo, {
        tenant: "t-1",
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("Portal API error");
  });
});
