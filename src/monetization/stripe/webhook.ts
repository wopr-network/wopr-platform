import type Stripe from "stripe";
import type { TenantCustomerStore } from "./tenant-store.js";

/**
 * Result of processing a Stripe webhook event.
 */
export interface WebhookResult {
  handled: boolean;
  event_type: string;
  tenant?: string;
}

/**
 * Process a Stripe webhook event.
 *
 * Handles the events WOPR cares about:
 * - checkout.session.completed — record customer mapping after checkout
 * - customer.subscription.updated — track tier changes
 * - customer.subscription.deleted — handle cancellation
 *
 * All other event types are acknowledged but not processed.
 */
export function handleWebhookEvent(tenantStore: TenantCustomerStore, event: Stripe.Event): WebhookResult {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenant = session.client_reference_id ?? session.metadata?.wopr_tenant;

      if (tenant && session.customer && session.subscription) {
        const customerId = typeof session.customer === "string" ? session.customer : session.customer.id;
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription.id;

        tenantStore.upsert({
          tenant,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
        });

        return { handled: true, event_type: event.type, tenant };
      }

      return { handled: false, event_type: event.type };
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const mapping = tenantStore.getByStripeCustomerId(customerId);

      if (mapping) {
        tenantStore.setSubscription(mapping.tenant, subscription.id);
        return { handled: true, event_type: event.type, tenant: mapping.tenant };
      }

      return { handled: false, event_type: event.type };
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const mapping = tenantStore.getByStripeCustomerId(customerId);

      if (mapping) {
        tenantStore.setTier(mapping.tenant, "free");
        tenantStore.setSubscription(mapping.tenant, null);
        return { handled: true, event_type: event.type, tenant: mapping.tenant };
      }

      return { handled: false, event_type: event.type };
    }

    default:
      return { handled: false, event_type: event.type };
  }
}
