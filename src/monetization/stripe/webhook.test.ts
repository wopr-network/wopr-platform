import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebhookEvent, type WebhookDeps } from "./webhook.js";

describe("handleWebhookEvent", () => {
  let deps: WebhookDeps;
  let mockUpsert: ReturnType<typeof vi.fn>;
  let mockGrant: ReturnType<typeof vi.fn>;
  let mockHasReferenceId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUpsert = vi.fn();
    mockGrant = vi.fn();
    mockHasReferenceId = vi.fn().mockReturnValue(false);

    deps = {
      tenantStore: {
        upsert: mockUpsert,
        getByTenant: vi.fn(),
        getByStripeCustomerId: vi.fn(),
        list: vi.fn(),
        setTier: vi.fn(),
        setBillingHold: vi.fn(),
        hasBillingHold: vi.fn(),
        buildCustomerIdMap: vi.fn(),
      } as unknown as WebhookDeps["tenantStore"],
      creditStore: {
        grant: mockGrant,
        hasReferenceId: mockHasReferenceId,
        getBalance: vi.fn(),
        refund: vi.fn(),
        correction: vi.fn(),
        listTransactions: vi.fn(),
        getTransaction: vi.fn(),
      } as unknown as WebhookDeps["creditStore"],
    };
  });

  function makeCheckoutEvent(overrides: Record<string, unknown> = {}): Stripe.Event {
    return {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          client_reference_id: "tenant-abc",
          customer: "cus_stripe_123",
          amount_total: 2500,
          metadata: {},
          ...overrides,
        },
      },
    } as unknown as Stripe.Event;
  }

  describe("checkout.session.completed", () => {
    it("upserts tenant mapping and grants credits", () => {
      const result = handleWebhookEvent(deps, makeCheckoutEvent());

      expect(result.handled).toBe(true);
      expect(result.event_type).toBe("checkout.session.completed");
      expect(result.tenant).toBe("tenant-abc");
      expect(result.creditedCents).toBe(2500);

      expect(mockUpsert).toHaveBeenCalledWith({
        tenant: "tenant-abc",
        stripeCustomerId: "cus_stripe_123",
      });
      expect(mockGrant).toHaveBeenCalledWith(
        "tenant-abc",
        2500,
        expect.stringContaining("cs_test_123"),
        "stripe-webhook",
        ["cs_test_123"],
      );
    });

    it("uses wopr_tenant metadata when client_reference_id is null", () => {
      const event = makeCheckoutEvent({
        client_reference_id: null,
        metadata: { wopr_tenant: "tenant-meta" },
      });

      const result = handleWebhookEvent(deps, event);
      expect(result.tenant).toBe("tenant-meta");
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: "tenant-meta" }),
      );
    });

    it("returns handled: false when tenant is missing", () => {
      const event = makeCheckoutEvent({
        client_reference_id: null,
        metadata: {},
      });

      const result = handleWebhookEvent(deps, event);
      expect(result.handled).toBe(false);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("returns handled: false when customer is missing", () => {
      const event = makeCheckoutEvent({ customer: null });

      const result = handleWebhookEvent(deps, event);
      expect(result.handled).toBe(false);
    });

    it("handles string customer (already a string ID)", () => {
      handleWebhookEvent(deps, makeCheckoutEvent({ customer: "cus_direct" }));
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ stripeCustomerId: "cus_direct" }),
      );
    });

    it("handles customer object (extracts .id)", () => {
      const event = makeCheckoutEvent({ customer: { id: "cus_obj" } });
      handleWebhookEvent(deps, event);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ stripeCustomerId: "cus_obj" }),
      );
    });

    it("returns creditedCents: 0 when amount_total is null", () => {
      const event = makeCheckoutEvent({ amount_total: null });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it("returns creditedCents: 0 when amount_total is 0", () => {
      const event = makeCheckoutEvent({ amount_total: 0 });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it("returns creditedCents: 0 when amount_total is negative", () => {
      const event = makeCheckoutEvent({ amount_total: -100 });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("skips duplicate session (idempotency check)", () => {
      mockHasReferenceId.mockReturnValue(true);
      const event = makeCheckoutEvent();
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
      expect(mockGrant).not.toHaveBeenCalled();
    });

    it("uses price map bonus when amount matches a tier", () => {
      const priceMap = new Map([
        ["price_25", { label: "$25", amountCents: 2500, creditCents: 2550, bonusPercent: 2 }],
      ]);

      const result = handleWebhookEvent({ ...deps, priceMap }, makeCheckoutEvent({ amount_total: 2500 }));
      expect(result.creditedCents).toBe(2550);
    });

    it("falls back to 1:1 when price map has no matching tier", () => {
      const priceMap = new Map([
        ["price_50", { label: "$50", amountCents: 5000, creditCents: 5250, bonusPercent: 5 }],
      ]);

      const result = handleWebhookEvent({ ...deps, priceMap }, makeCheckoutEvent({ amount_total: 7500 }));
      expect(result.creditedCents).toBe(7500);
    });

    it("falls back to 1:1 when no price map is provided", () => {
      const result = handleWebhookEvent(deps, makeCheckoutEvent({ amount_total: 3333 }));
      expect(result.creditedCents).toBe(3333);
    });
  });

  describe("unhandled event types", () => {
    it("returns handled: false for unknown event types", () => {
      const event = {
        type: "customer.subscription.created",
        data: { object: {} },
      } as unknown as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result.handled).toBe(false);
      expect(result.event_type).toBe("customer.subscription.created");
    });

    it("returns handled: false for payment_intent events", () => {
      const event = {
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as unknown as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result.handled).toBe(false);
    });
  });
});
