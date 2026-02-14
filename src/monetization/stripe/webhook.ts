import type Stripe from "stripe";
import type { TenantCustomerStore } from "./tenant-store.js";

/**
 * Result of processing a Stripe webhook event.
 */
export interface WebhookResult {
  handled: boolean;
  event_type: string;
  tenant?: string;
  /** The previous tier before a downgrade, if applicable. */
  previousTier?: string;
}

/**
 * Callbacks invoked during tier-change webhook processing.
 *
 * All callbacks are optional -- callers that do not need side-effects
 * (e.g. unit tests) can omit them entirely.
 */
export interface WebhookHooks {
  /** Invalidate any in-memory tier/budget caches for the tenant. */
  onCacheInvalidate?: (tenant: string) => void;
  /** Log an audit event for the tier change. */
  onAuditLog?: (entry: { tenant: string; action: "tier.downgrade"; previousTier: string; newTier: string }) => void;
  /** Emit a tier-change event so other running instances can refresh. */
  onTierChange?: (entry: { tenant: string; previousTier: string; newTier: string }) => void;
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
export function handleWebhookEvent(
  tenantStore: TenantCustomerStore,
  event: Stripe.Event,
  hooks?: WebhookHooks,
): WebhookResult {
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

        // Clear any billing hold from a previous cancellation
        tenantStore.setBillingHold(tenant, false);

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
        const previousTier = mapping.tier;

        // 1. Set billing hold to block new API calls during transition
        tenantStore.setBillingHold(mapping.tenant, true);

        // 2. Downgrade tier to free and clear subscription
        tenantStore.setTier(mapping.tenant, "free");
        tenantStore.setSubscription(mapping.tenant, null);

        // 3. Invalidate any cached tier/budget data
        hooks?.onCacheInvalidate?.(mapping.tenant);

        // 4. Log audit event
        hooks?.onAuditLog?.({
          tenant: mapping.tenant,
          action: "tier.downgrade",
          previousTier,
          newTier: "free",
        });

        // 5. Emit tier-change event for other instances
        hooks?.onTierChange?.({
          tenant: mapping.tenant,
          previousTier,
          newTier: "free",
        });

        // 6. Clear billing hold now that transition is complete
        tenantStore.setBillingHold(mapping.tenant, false);

        return {
          handled: true,
          event_type: event.type,
          tenant: mapping.tenant,
          previousTier,
        };
      }

      return { handled: false, event_type: event.type };
    }

    default:
      return { handled: false, event_type: event.type };
  }
}
