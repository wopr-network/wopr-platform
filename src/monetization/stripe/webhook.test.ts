/**
 * Unit tests for Stripe webhook handler.
 *
 * Covers all event types, edge cases, duplicate events, error handling,
 * and tier-change cache invalidation / audit / event hooks (WOP-367).
 */
import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";
import type { WebhookHooks } from "./webhook.js";
import { handleWebhookEvent } from "./webhook.js";

describe("handleWebhookEvent", () => {
  let db: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    initStripeSchema(db);
    tenantStore = new TenantCustomerStore(db);
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
            client_reference_id: "tenant-123",
            customer: "cus_abc",
            subscription: "sub_xyz",
            metadata: {},
            ...overrides,
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
    }

    it("handles checkout with client_reference_id and creates tenant mapping", () => {
      const event = createCheckoutEvent();
      const result = handleWebhookEvent(tenantStore, event);

      expect(result).toEqual({
        handled: true,
        event_type: "checkout.session.completed",
        tenant: "tenant-123",
      });

      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping).not.toBeNull();
      expect(mapping?.stripe_customer_id).toBe("cus_abc");
      expect(mapping?.stripe_subscription_id).toBe("sub_xyz");
    });

    it("handles checkout with tenant in metadata when client_reference_id is null", () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: { wopr_tenant: "tenant-from-metadata" },
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result).toEqual({
        handled: true,
        event_type: "checkout.session.completed",
        tenant: "tenant-from-metadata",
      });

      const mapping = tenantStore.getByTenant("tenant-from-metadata");
      expect(mapping?.stripe_customer_id).toBe("cus_abc");
    });

    it("handles checkout with customer object instead of string", () => {
      const event = createCheckoutEvent({
        customer: { id: "cus_obj_123" } as Stripe.Customer,
        subscription: { id: "sub_obj_456" } as Stripe.Subscription,
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result.handled).toBe(true);
      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping?.stripe_customer_id).toBe("cus_obj_123");
      expect(mapping?.stripe_subscription_id).toBe("sub_obj_456");
    });

    it("returns handled:false when tenant is missing", () => {
      const event = createCheckoutEvent({
        client_reference_id: null,
        metadata: {},
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result).toEqual({
        handled: false,
        event_type: "checkout.session.completed",
      });
    });

    it("returns handled:false when customer is missing", () => {
      const event = createCheckoutEvent({
        customer: null,
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result.handled).toBe(false);
    });

    it("returns handled:false when subscription is missing", () => {
      const event = createCheckoutEvent({
        subscription: null,
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result.handled).toBe(false);
    });

    it("handles duplicate checkout events idempotently", () => {
      const event = createCheckoutEvent();

      const result1 = handleWebhookEvent(tenantStore, event);
      expect(result1.handled).toBe(true);

      const result2 = handleWebhookEvent(tenantStore, event);
      expect(result2.handled).toBe(true);

      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping?.stripe_customer_id).toBe("cus_abc");
      expect(mapping?.stripe_subscription_id).toBe("sub_xyz");
    });

    it("updates existing tenant mapping on re-checkout", () => {
      // Initial checkout
      tenantStore.upsert({
        tenant: "tenant-123",
        stripeCustomerId: "cus_old",
        stripeSubscriptionId: "sub_old",
      });

      // New checkout with new IDs
      const event = createCheckoutEvent({
        customer: "cus_new",
        subscription: "sub_new",
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result.handled).toBe(true);
      const mapping = tenantStore.getByTenant("tenant-123");
      expect(mapping?.stripe_customer_id).toBe("cus_new");
      expect(mapping?.stripe_subscription_id).toBe("sub_new");
    });

    it("clears billing hold on re-checkout after cancellation", () => {
      tenantStore.upsert({
        tenant: "tenant-resubscribe",
        stripeCustomerId: "cus_resub",
        stripeSubscriptionId: "sub_old",
      });
      tenantStore.setBillingHold("tenant-resubscribe", true);
      expect(tenantStore.hasBillingHold("tenant-resubscribe")).toBe(true);

      const event = createCheckoutEvent({
        client_reference_id: "tenant-resubscribe",
        customer: "cus_resub",
        subscription: "sub_new",
      });
      handleWebhookEvent(tenantStore, event);

      expect(tenantStore.hasBillingHold("tenant-resubscribe")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // customer.subscription.updated
  // ---------------------------------------------------------------------------

  describe("customer.subscription.updated", () => {
    function createSubscriptionUpdatedEvent(overrides?: Partial<Stripe.Subscription>): Stripe.Event {
      return {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_new_id",
            customer: "cus_abc",
            ...overrides,
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
    }

    it("updates subscription ID for known customer", () => {
      tenantStore.upsert({
        tenant: "tenant-456",
        stripeCustomerId: "cus_abc",
        stripeSubscriptionId: "sub_old",
      });

      const event = createSubscriptionUpdatedEvent({ id: "sub_updated" });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result).toEqual({
        handled: true,
        event_type: "customer.subscription.updated",
        tenant: "tenant-456",
      });

      const mapping = tenantStore.getByTenant("tenant-456");
      expect(mapping?.stripe_subscription_id).toBe("sub_updated");
    });

    it("handles subscription with customer object instead of string", () => {
      tenantStore.upsert({
        tenant: "tenant-789",
        stripeCustomerId: "cus_obj",
        stripeSubscriptionId: "sub_old",
      });

      const event = createSubscriptionUpdatedEvent({
        customer: { id: "cus_obj" } as Stripe.Customer,
        id: "sub_new",
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result.handled).toBe(true);
      const mapping = tenantStore.getByTenant("tenant-789");
      expect(mapping?.stripe_subscription_id).toBe("sub_new");
    });

    it("returns handled:false for unknown customer", () => {
      const event = createSubscriptionUpdatedEvent({ customer: "cus_unknown" });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.updated",
      });
    });

    it("is idempotent for duplicate events", () => {
      tenantStore.upsert({
        tenant: "tenant-999",
        stripeCustomerId: "cus_dup",
        stripeSubscriptionId: "sub_old",
      });

      const event = createSubscriptionUpdatedEvent({
        customer: "cus_dup",
        id: "sub_final",
      });

      const result1 = handleWebhookEvent(tenantStore, event);
      expect(result1.handled).toBe(true);

      const result2 = handleWebhookEvent(tenantStore, event);
      expect(result2.handled).toBe(true);

      const mapping = tenantStore.getByTenant("tenant-999");
      expect(mapping?.stripe_subscription_id).toBe("sub_final");
    });
  });

  // ---------------------------------------------------------------------------
  // customer.subscription.deleted
  // ---------------------------------------------------------------------------

  describe("customer.subscription.deleted", () => {
    function createSubscriptionDeletedEvent(overrides?: Partial<Stripe.Subscription>): Stripe.Event {
      return {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_deleted",
            customer: "cus_deleted",
            ...overrides,
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
    }

    it("sets tier to free and clears subscription for known customer", () => {
      tenantStore.upsert({
        tenant: "tenant-cancel",
        stripeCustomerId: "cus_deleted",
        stripeSubscriptionId: "sub_deleted",
      });
      tenantStore.setTier("tenant-cancel", "pro");

      const event = createSubscriptionDeletedEvent();
      const result = handleWebhookEvent(tenantStore, event);

      expect(result).toEqual({
        handled: true,
        event_type: "customer.subscription.deleted",
        tenant: "tenant-cancel",
        previousTier: "pro",
      });

      const mapping = tenantStore.getByTenant("tenant-cancel");
      expect(mapping?.tier).toBe("free");
      expect(mapping?.stripe_subscription_id).toBeNull();
    });

    it("handles subscription deletion with customer object", () => {
      tenantStore.upsert({
        tenant: "tenant-obj-cancel",
        stripeCustomerId: "cus_obj_del",
        stripeSubscriptionId: "sub_obj_del",
      });
      tenantStore.setTier("tenant-obj-cancel", "enterprise");

      const event = createSubscriptionDeletedEvent({
        customer: { id: "cus_obj_del" } as Stripe.Customer,
      });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result.handled).toBe(true);
      expect(result.previousTier).toBe("enterprise");
      const mapping = tenantStore.getByTenant("tenant-obj-cancel");
      expect(mapping?.tier).toBe("free");
      expect(mapping?.stripe_subscription_id).toBeNull();
    });

    it("returns handled:false for unknown customer", () => {
      const event = createSubscriptionDeletedEvent({ customer: "cus_unknown" });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result).toEqual({
        handled: false,
        event_type: "customer.subscription.deleted",
      });
    });

    it("is idempotent for duplicate deletion events", () => {
      tenantStore.upsert({
        tenant: "tenant-dup-del",
        stripeCustomerId: "cus_dup_del",
        stripeSubscriptionId: "sub_dup_del",
      });
      tenantStore.setTier("tenant-dup-del", "pro");

      const event = createSubscriptionDeletedEvent({ customer: "cus_dup_del" });

      const result1 = handleWebhookEvent(tenantStore, event);
      expect(result1.handled).toBe(true);
      expect(result1.previousTier).toBe("pro");

      const result2 = handleWebhookEvent(tenantStore, event);
      expect(result2.handled).toBe(true);
      expect(result2.previousTier).toBe("free"); // Already downgraded

      const mapping = tenantStore.getByTenant("tenant-dup-del");
      expect(mapping?.tier).toBe("free");
      expect(mapping?.stripe_subscription_id).toBeNull();
    });

    it("returns previousTier in the result", () => {
      tenantStore.upsert({
        tenant: "tenant-prev",
        stripeCustomerId: "cus_prev",
        stripeSubscriptionId: "sub_prev",
      });
      tenantStore.setTier("tenant-prev", "team");

      const event = createSubscriptionDeletedEvent({ customer: "cus_prev" });
      const result = handleWebhookEvent(tenantStore, event);

      expect(result.previousTier).toBe("team");
    });
  });

  // ---------------------------------------------------------------------------
  // Webhook hooks (WOP-367: cache invalidation, audit, event emission)
  // ---------------------------------------------------------------------------

  describe("webhook hooks (WOP-367)", () => {
    function createSubscriptionDeletedEvent(overrides?: Partial<Stripe.Subscription>): Stripe.Event {
      return {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_hook",
            customer: "cus_hook",
            ...overrides,
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
    }

    it("invokes onCacheInvalidate on subscription deletion", () => {
      tenantStore.upsert({
        tenant: "tenant-cache",
        stripeCustomerId: "cus_hook",
        stripeSubscriptionId: "sub_hook",
      });
      tenantStore.setTier("tenant-cache", "pro");

      const hooks: WebhookHooks = {
        onCacheInvalidate: vi.fn(),
      };

      handleWebhookEvent(tenantStore, createSubscriptionDeletedEvent(), hooks);

      expect(hooks.onCacheInvalidate).toHaveBeenCalledWith("tenant-cache");
      expect(hooks.onCacheInvalidate).toHaveBeenCalledTimes(1);
    });

    it("invokes onAuditLog with correct tier details on deletion", () => {
      tenantStore.upsert({
        tenant: "tenant-audit",
        stripeCustomerId: "cus_hook",
        stripeSubscriptionId: "sub_hook",
      });
      tenantStore.setTier("tenant-audit", "enterprise");

      const hooks: WebhookHooks = {
        onAuditLog: vi.fn(),
      };

      handleWebhookEvent(tenantStore, createSubscriptionDeletedEvent(), hooks);

      expect(hooks.onAuditLog).toHaveBeenCalledWith({
        tenant: "tenant-audit",
        action: "tier.downgrade",
        previousTier: "enterprise",
        newTier: "free",
      });
    });

    it("invokes onTierChange on subscription deletion", () => {
      tenantStore.upsert({
        tenant: "tenant-event",
        stripeCustomerId: "cus_hook",
        stripeSubscriptionId: "sub_hook",
      });
      tenantStore.setTier("tenant-event", "pro");

      const hooks: WebhookHooks = {
        onTierChange: vi.fn(),
      };

      handleWebhookEvent(tenantStore, createSubscriptionDeletedEvent(), hooks);

      expect(hooks.onTierChange).toHaveBeenCalledWith({
        tenant: "tenant-event",
        previousTier: "pro",
        newTier: "free",
      });
    });

    it("invokes all hooks together on subscription deletion", () => {
      tenantStore.upsert({
        tenant: "tenant-all",
        stripeCustomerId: "cus_hook",
        stripeSubscriptionId: "sub_hook",
      });
      tenantStore.setTier("tenant-all", "team");

      const hooks: WebhookHooks = {
        onCacheInvalidate: vi.fn(),
        onAuditLog: vi.fn(),
        onTierChange: vi.fn(),
      };

      const result = handleWebhookEvent(tenantStore, createSubscriptionDeletedEvent(), hooks);

      expect(result.handled).toBe(true);
      expect(result.previousTier).toBe("team");
      expect(hooks.onCacheInvalidate).toHaveBeenCalledTimes(1);
      expect(hooks.onAuditLog).toHaveBeenCalledTimes(1);
      expect(hooks.onTierChange).toHaveBeenCalledTimes(1);
    });

    it("does not invoke hooks for unknown customer deletion", () => {
      const hooks: WebhookHooks = {
        onCacheInvalidate: vi.fn(),
        onAuditLog: vi.fn(),
        onTierChange: vi.fn(),
      };

      const event = createSubscriptionDeletedEvent({ customer: "cus_unknown" });
      handleWebhookEvent(tenantStore, event, hooks);

      expect(hooks.onCacheInvalidate).not.toHaveBeenCalled();
      expect(hooks.onAuditLog).not.toHaveBeenCalled();
      expect(hooks.onTierChange).not.toHaveBeenCalled();
    });

    it("does not invoke hooks for non-deletion events", () => {
      tenantStore.upsert({
        tenant: "tenant-nohook",
        stripeCustomerId: "cus_nohook",
        stripeSubscriptionId: "sub_nohook",
      });

      const hooks: WebhookHooks = {
        onCacheInvalidate: vi.fn(),
        onAuditLog: vi.fn(),
        onTierChange: vi.fn(),
      };

      const updateEvent = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_updated",
            customer: "cus_nohook",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      handleWebhookEvent(tenantStore, updateEvent, hooks);

      expect(hooks.onCacheInvalidate).not.toHaveBeenCalled();
      expect(hooks.onAuditLog).not.toHaveBeenCalled();
      expect(hooks.onTierChange).not.toHaveBeenCalled();
    });

    it("works without hooks (backward compatibility)", () => {
      tenantStore.upsert({
        tenant: "tenant-nohooks",
        stripeCustomerId: "cus_hook",
        stripeSubscriptionId: "sub_hook",
      });
      tenantStore.setTier("tenant-nohooks", "pro");

      // No hooks passed -- should not throw
      const result = handleWebhookEvent(tenantStore, createSubscriptionDeletedEvent());

      expect(result.handled).toBe(true);
      expect(result.previousTier).toBe("pro");
      const mapping = tenantStore.getByTenant("tenant-nohooks");
      expect(mapping?.tier).toBe("free");
    });

    it("clears billing hold after subscription deletion completes", () => {
      tenantStore.upsert({
        tenant: "tenant-hold",
        stripeCustomerId: "cus_hook",
        stripeSubscriptionId: "sub_hook",
      });
      tenantStore.setTier("tenant-hold", "pro");

      handleWebhookEvent(tenantStore, createSubscriptionDeletedEvent());

      // After webhook completes, billing hold should be cleared
      expect(tenantStore.hasBillingHold("tenant-hold")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Billing hold (WOP-367)
  // ---------------------------------------------------------------------------

  describe("billing hold", () => {
    it("setBillingHold sets and clears the hold flag", () => {
      tenantStore.upsert({
        tenant: "tenant-hold-test",
        stripeCustomerId: "cus_hold",
        stripeSubscriptionId: "sub_hold",
      });

      expect(tenantStore.hasBillingHold("tenant-hold-test")).toBe(false);

      tenantStore.setBillingHold("tenant-hold-test", true);
      expect(tenantStore.hasBillingHold("tenant-hold-test")).toBe(true);

      tenantStore.setBillingHold("tenant-hold-test", false);
      expect(tenantStore.hasBillingHold("tenant-hold-test")).toBe(false);
    });

    it("hasBillingHold returns false for unknown tenant", () => {
      expect(tenantStore.hasBillingHold("nonexistent-tenant")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Unhandled event types
  // ---------------------------------------------------------------------------

  describe("unhandled event types", () => {
    it("returns handled:false for payment_intent.succeeded", () => {
      const event = {
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, event);
      expect(result).toEqual({
        handled: false,
        event_type: "payment_intent.succeeded",
      });
    });

    it("returns handled:false for invoice.paid", () => {
      const event = {
        type: "invoice.paid",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, event);
      expect(result).toEqual({
        handled: false,
        event_type: "invoice.paid",
      });
    });

    it("returns handled:false for charge.succeeded", () => {
      const event = {
        type: "charge.succeeded",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, event);
      expect(result).toEqual({
        handled: false,
        event_type: "charge.succeeded",
      });
    });

    it("returns handled:false for customer.created", () => {
      const event = {
        type: "customer.created",
        data: { object: {} },
      } as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, event);
      expect(result).toEqual({
        handled: false,
        event_type: "customer.created",
      });
    });

    it("handles unknown event type gracefully", () => {
      const event = {
        type: "wopr.custom.event",
        data: { object: {} },
      } as unknown as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, event);
      expect(result).toEqual({
        handled: false,
        event_type: "wopr.custom.event",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Out-of-order delivery
  // ---------------------------------------------------------------------------

  describe("out-of-order event delivery", () => {
    it("handles subscription.deleted arriving before checkout.completed", () => {
      // Deletion event arrives first
      tenantStore.upsert({
        tenant: "tenant-race",
        stripeCustomerId: "cus_race",
        stripeSubscriptionId: "sub_race",
      });

      const deleteEvent = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_race",
            customer: "cus_race",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      const deleteResult = handleWebhookEvent(tenantStore, deleteEvent);
      expect(deleteResult.handled).toBe(true);

      const mapping = tenantStore.getByTenant("tenant-race");
      expect(mapping?.tier).toBe("free");
      expect(mapping?.stripe_subscription_id).toBeNull();

      // Checkout event arrives late (out of order)
      const checkoutEvent = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "tenant-race",
            customer: "cus_race",
            subscription: "sub_race",
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const checkoutResult = handleWebhookEvent(tenantStore, checkoutEvent);
      expect(checkoutResult.handled).toBe(true);

      // Checkout should upsert the subscription again
      const finalMapping = tenantStore.getByTenant("tenant-race");
      expect(finalMapping?.stripe_subscription_id).toBe("sub_race");
    });

    it("handles subscription.updated arriving before checkout.completed", () => {
      // Update event arrives first (no mapping exists yet)
      const updateEvent = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_early_update",
            customer: "cus_early",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      const updateResult = handleWebhookEvent(tenantStore, updateEvent);
      expect(updateResult.handled).toBe(false);

      // Checkout arrives later
      const checkoutEvent = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "tenant-early",
            customer: "cus_early",
            subscription: "sub_early",
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const checkoutResult = handleWebhookEvent(tenantStore, checkoutEvent);
      expect(checkoutResult.handled).toBe(true);

      const mapping = tenantStore.getByTenant("tenant-early");
      expect(mapping?.stripe_subscription_id).toBe("sub_early");
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty string customer ID gracefully", () => {
      const event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "tenant-empty",
            customer: "",
            subscription: "sub_xyz",
            metadata: {},
          } as unknown as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, event);
      expect(result.handled).toBe(false);
    });

    it("handles null subscription ID gracefully", () => {
      const event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "tenant-null-sub",
            customer: "cus_xyz",
            subscription: null,
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, event);
      expect(result.handled).toBe(false);
    });

    it("handles malformed subscription object", () => {
      const event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "",
            customer: "cus_malformed",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      tenantStore.upsert({
        tenant: "tenant-malformed",
        stripeCustomerId: "cus_malformed",
        stripeSubscriptionId: "sub_old",
      });

      const result = handleWebhookEvent(tenantStore, event);
      expect(result.handled).toBe(true);
    });

    it("preserves customer ID when only subscription is updated", () => {
      tenantStore.upsert({
        tenant: "tenant-preserve",
        stripeCustomerId: "cus_preserve",
        stripeSubscriptionId: "sub_old",
      });

      const event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_new",
            customer: "cus_preserve",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      handleWebhookEvent(tenantStore, event);

      const mapping = tenantStore.getByTenant("tenant-preserve");
      expect(mapping?.stripe_customer_id).toBe("cus_preserve");
      expect(mapping?.stripe_subscription_id).toBe("sub_new");
    });
  });
});
