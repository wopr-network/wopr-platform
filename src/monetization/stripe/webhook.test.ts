/**
 * Unit tests for Stripe webhook handler (credit purchase model, WOP-406).
 *
 * Covers checkout.session.completed crediting the ledger,
 * bonus tier application, edge cases, and unknown events.
 */
import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreditAdjustmentStore } from "../../admin/credits/adjustment-store.js";
import { initCreditAdjustmentSchema } from "../../admin/credits/schema.js";
import { CREDIT_PRICE_POINTS } from "./credit-prices.js";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";
import type { WebhookDeps } from "./webhook.js";
import { handleWebhookEvent } from "./webhook.js";

describe("handleWebhookEvent (credit model)", () => {
  let db: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;
  let creditStore: CreditAdjustmentStore;
  let deps: WebhookDeps;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    initStripeSchema(db);
    initCreditAdjustmentSchema(db);
    tenantStore = new TenantCustomerStore(db);
    creditStore = new CreditAdjustmentStore(db);
    deps = { tenantStore, creditStore };
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // checkout.session.completed
  // ---------------------------------------------------------------------------

  describe("checkout.session.completed", () => {
    function createCheckoutEvent(overrides?: Partial<Stripe.Checkout.Session>): Stripe.Event {
      return {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_123",
            client_reference_id: "tenant-123",
            customer: "cus_abc",
            amount_total: 2500,
            metadata: {},
            ...overrides,
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
    }

    it("credits the ledger on successful checkout", () => {
      const event = createCheckoutEvent();
      const result = handleWebhookEvent(deps, event);

      expect(result).toEqual({
        handled: true,
        event_type: "checkout.session.completed",
        tenant: "tenant-123",
        creditedCents: 2500,
      });

      // Verify credits were granted
      const balance = creditStore.getBalance("tenant-123");
      expect(balance).toBe(2500);
    });

    it("applies bonus tiers when priceMap is provided", () => {
      // $25 purchase -> $25.50 credit (2% bonus)
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_25", CREDIT_PRICE_POINTS[2]]]),
      };

      const event = createCheckoutEvent({ amount_total: 2500 });
      const result = handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(2550); // 2% bonus
    });

    it("applies 5% bonus for $50 purchase", () => {
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_50", CREDIT_PRICE_POINTS[3]]]),
      };

      const event = createCheckoutEvent({ amount_total: 5000 });
      const result = handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(5250); // 5% bonus
    });

    it("applies 10% bonus for $100 purchase", () => {
      const depsWithMap: WebhookDeps = {
        ...deps,
        priceMap: new Map([["price_100", CREDIT_PRICE_POINTS[4]]]),
      };

      const event = createCheckoutEvent({ amount_total: 10000 });
      const result = handleWebhookEvent(depsWithMap, event);

      expect(result.creditedCents).toBe(11000); // 10% bonus
    });

    it("creates tenant-to-customer mapping", () => {
      const event = createCheckoutEvent();
      handleWebhookEvent(deps, event);

      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping).not.toBeNull();
      expect(mapping?.stripe_customer_id).toBe("cus_abc");
    });

    it("handles tenant from metadata when client_reference_id is null", () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: { wopr_tenant: "tenant-from-metadata" },
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.tenant).toBe("tenant-from-metadata");

      const balance = creditStore.getBalance("tenant-from-metadata");
      expect(balance).toBe(2500);
    });

    it("handles customer object instead of string", () => {
      const event = createCheckoutEvent({
        customer: { id: "cus_obj_123" } as Stripe.Customer,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping?.stripe_customer_id).toBe("cus_obj_123");
    });

    it("returns handled:false when tenant is missing", () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: {},
      });
      const result = handleWebhookEvent(deps, event);

      expect(result).toEqual({
        handled: false,
        event_type: "checkout.session.completed",
      });
    });

    it("returns handled:false when customer is missing", () => {
      const event = createCheckoutEvent({
        customer: null,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(false);
    });

    it("returns creditedCents:0 when amount_total is 0", () => {
      const event = createCheckoutEvent({
        amount_total: 0,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("returns creditedCents:0 when amount_total is null", () => {
      const event = createCheckoutEvent({
        amount_total: null,
      });
      const result = handleWebhookEvent(deps, event);

      expect(result.handled).toBe(true);
      expect(result.creditedCents).toBe(0);
    });

    it("handles duplicate checkout events idempotently (skips second)", () => {
      const event = createCheckoutEvent({ amount_total: 500 });

      const first = handleWebhookEvent(deps, event);
      expect(first.creditedCents).toBe(500);

      const second = handleWebhookEvent(deps, event);
      expect(second.handled).toBe(true);
      expect(second.creditedCents).toBe(0);

      // Only credited once despite duplicate webhook delivery
      const balance = creditStore.getBalance("tenant-123");
      expect(balance).toBe(500);
    });

    it("grants 1:1 credits when no priceMap is provided", () => {
      const event = createCheckoutEvent({ amount_total: 1234 });
      const result = handleWebhookEvent(deps, event);

      expect(result.creditedCents).toBe(1234);
    });

    it("records the Stripe session ID in the grant reason and reference_ids", () => {
      const event = createCheckoutEvent({ id: "cs_test_abc" });
      handleWebhookEvent(deps, event);

      const txns = creditStore.listTransactions("tenant-123");
      expect(txns.entries).toHaveLength(1);
      expect(txns.entries[0].reason).toContain("cs_test_abc");
      expect(txns.entries[0].type).toBe("grant");
      expect(txns.entries[0].admin_user).toBe("stripe-webhook");
      expect(txns.entries[0].reference_ids).toBe('["cs_test_abc"]');
    });
  });

  // ---------------------------------------------------------------------------
  // Unhandled event types
  // ---------------------------------------------------------------------------

  describe("unhandled event types", () => {
    it("returns handled:false for customer.subscription.updated", () => {
      const event = {
        type: "customer.subscription.updated",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.updated",
      });
    });

    it("returns handled:false for customer.subscription.deleted", () => {
      const event = {
        type: "customer.subscription.deleted",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.deleted",
      });
    });

    it("returns handled:false for payment_intent.succeeded", () => {
      const event = {
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "payment_intent.succeeded",
      });
    });

    it("handles unknown event type gracefully", () => {
      const event = {
        type: "wopr.custom.event",
        data: { object: {} },
      } as unknown as Stripe.Event;

      const result = handleWebhookEvent(deps, event);
      expect(result).toEqual({
        handled: false,
        event_type: "wopr.custom.event",
      });
    });
  });
});
