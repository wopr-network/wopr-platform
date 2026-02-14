/**
 * Integration tests for auth-to-billing flow.
 *
 * Tests the complete journey:
 * 1. User registers (auth)
 * 2. User subscribes (billing)
 * 3. Subscription lifecycle (webhooks)
 * 4. Tier transitions
 */
import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initStripeSchema } from "../../src/monetization/stripe/schema.js";
import { TenantCustomerStore } from "../../src/monetization/stripe/tenant-store.js";
import { handleWebhookEvent } from "../../src/monetization/stripe/webhook.js";

describe("integration: auth → billing → metering flow", () => {
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
  // Complete flow: Register → Subscribe → Use
  // ---------------------------------------------------------------------------

  describe("complete user journey", () => {
    it("free tier user → upgrade to pro → downgrade to free", () => {
      const tenantId = "tenant-journey-1";

      // Step 1: User registers (starts on free tier)
      tenantStore.upsert({
        tenant: tenantId,
        stripeCustomerId: "cus_new_user",
        stripeSubscriptionId: null,
      });
      tenantStore.setTier(tenantId, "free");

      let mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("free");

      // Step 2: User subscribes to pro via Stripe checkout
      const checkoutEvent: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: tenantId,
            customer: "cus_new_user",
            subscription: "sub_pro_123",
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const checkoutResult = handleWebhookEvent(tenantStore, checkoutEvent);
      expect(checkoutResult.handled).toBe(true);

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.stripe_subscription_id).toBe("sub_pro_123");

      // Step 3: Upgrade tier to pro (simulating tier detection)
      tenantStore.setTier(tenantId, "pro");

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("pro");

      // Step 4: User cancels subscription
      const cancelEvent: Stripe.Event = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_pro_123",
            customer: "cus_new_user",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      const cancelResult = handleWebhookEvent(tenantStore, cancelEvent);
      expect(cancelResult.handled).toBe(true);

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("free");
      expect(mapping?.stripe_subscription_id).toBeNull();
    });

    it("handles tier transition: free → pro → enterprise → free", () => {
      const tenantId = "tenant-tier-transitions";

      tenantStore.upsert({
        tenant: tenantId,
        stripeCustomerId: "cus_transitions",
        stripeSubscriptionId: null,
      });

      // Start: Free tier
      tenantStore.setTier(tenantId, "free");
      let mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("free");

      // Upgrade to Pro
      const proCheckout: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: tenantId,
            customer: "cus_transitions",
            subscription: "sub_pro",
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
      handleWebhookEvent(tenantStore, proCheckout);
      tenantStore.setTier(tenantId, "pro");

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("pro");

      // Upgrade to Enterprise
      const enterpriseUpdate: Stripe.Event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_enterprise",
            customer: "cus_transitions",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
      handleWebhookEvent(tenantStore, enterpriseUpdate);
      tenantStore.setTier(tenantId, "enterprise");

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("enterprise");

      // Downgrade back to Free
      const deleteEvent: Stripe.Event = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_enterprise",
            customer: "cus_transitions",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
      handleWebhookEvent(tenantStore, deleteEvent);

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("free");
    });
  });

  // ---------------------------------------------------------------------------
  // Subscription lifecycle edge cases
  // ---------------------------------------------------------------------------

  describe("subscription lifecycle edge cases", () => {
    it("handles checkout → immediate cancellation", () => {
      const tenantId = "tenant-immediate-cancel";

      const checkoutEvent: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: tenantId,
            customer: "cus_immediate",
            subscription: "sub_immediate",
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      handleWebhookEvent(tenantStore, checkoutEvent);
      tenantStore.setTier(tenantId, "pro");

      let mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.stripe_subscription_id).toBe("sub_immediate");

      const cancelEvent: Stripe.Event = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_immediate",
            customer: "cus_immediate",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      handleWebhookEvent(tenantStore, cancelEvent);

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("free");
      expect(mapping?.stripe_subscription_id).toBeNull();
    });

    it("handles multiple subscription updates in sequence", () => {
      const tenantId = "tenant-multi-updates";

      tenantStore.upsert({
        tenant: tenantId,
        stripeCustomerId: "cus_multi",
        stripeSubscriptionId: "sub_v1",
      });

      const update1: Stripe.Event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_v2",
            customer: "cus_multi",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
      handleWebhookEvent(tenantStore, update1);

      let mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.stripe_subscription_id).toBe("sub_v2");

      const update2: Stripe.Event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_v3",
            customer: "cus_multi",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
      handleWebhookEvent(tenantStore, update2);

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.stripe_subscription_id).toBe("sub_v3");
    });

    it("preserves customer ID across subscription changes", () => {
      const tenantId = "tenant-preserve-customer";
      const customerId = "cus_stable";

      tenantStore.upsert({
        tenant: tenantId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: "sub_old",
      });

      const updateEvent: Stripe.Event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_new",
            customer: customerId,
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      handleWebhookEvent(tenantStore, updateEvent);

      const mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.stripe_customer_id).toBe(customerId);
      expect(mapping?.stripe_subscription_id).toBe("sub_new");
    });

    it("handles re-subscription after cancellation", () => {
      const tenantId = "tenant-resubscribe";

      tenantStore.upsert({
        tenant: tenantId,
        stripeCustomerId: "cus_resub",
        stripeSubscriptionId: "sub_first",
      });
      tenantStore.setTier(tenantId, "pro");

      const cancelEvent: Stripe.Event = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_first",
            customer: "cus_resub",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;
      handleWebhookEvent(tenantStore, cancelEvent);

      let mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.tier).toBe("free");

      const recheckoutEvent: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: tenantId,
            customer: "cus_resub",
            subscription: "sub_second",
            metadata: {},
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;
      handleWebhookEvent(tenantStore, recheckoutEvent);
      tenantStore.setTier(tenantId, "pro");

      mapping = tenantStore.getByTenant(tenantId);
      expect(mapping?.stripe_subscription_id).toBe("sub_second");
      expect(mapping?.tier).toBe("pro");
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-tenant isolation
  // ---------------------------------------------------------------------------

  describe("multi-tenant isolation", () => {
    it("handles subscription events for different tenants independently", () => {
      const tenant1 = "tenant-sub-1";
      const tenant2 = "tenant-sub-2";

      tenantStore.upsert({
        tenant: tenant1,
        stripeCustomerId: "cus_sub_1",
        stripeSubscriptionId: "sub_1",
      });
      tenantStore.upsert({
        tenant: tenant2,
        stripeCustomerId: "cus_sub_2",
        stripeSubscriptionId: "sub_2",
      });

      const delete1: Stripe.Event = {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_1",
            customer: "cus_sub_1",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      handleWebhookEvent(tenantStore, delete1);

      const mapping1 = tenantStore.getByTenant(tenant1);
      expect(mapping1?.tier).toBe("free");
      expect(mapping1?.stripe_subscription_id).toBeNull();

      const mapping2 = tenantStore.getByTenant(tenant2);
      expect(mapping2?.stripe_subscription_id).toBe("sub_2");
    });
  });

  // ---------------------------------------------------------------------------
  // Error scenarios
  // ---------------------------------------------------------------------------

  describe("error scenarios", () => {
    it("handles subscription events for unknown customers", () => {
      const updateEvent: Stripe.Event = {
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_unknown",
            customer: "cus_unknown",
          } as Stripe.Subscription,
        },
      } as Stripe.Event;

      const result = handleWebhookEvent(tenantStore, updateEvent);
      expect(result.handled).toBe(false);
    });
  });
});
