import type Stripe from "stripe";
import type { IAffiliateRepository } from "../affiliate/drizzle-affiliate-repository.js";
import { grantNewUserBonus } from "../affiliate/new-user-bonus.js";
import type { BotBilling } from "../credits/bot-billing.js";
import type { CreditLedger } from "../credits/credit-ledger.js";
import type { IWebhookSeenRepository } from "../webhook-seen-repository.js";
import type { CreditPriceMap } from "./credit-prices.js";
import type { TenantCustomerStore } from "./tenant-store.js";

/**
 * Result of processing a Stripe webhook event.
 */
export interface WebhookResult {
  handled: boolean;
  event_type: string;
  tenant?: string;
  /** Credits granted in cents (for checkout.session.completed). */
  creditedCents?: number;
  /** Bot IDs reactivated after credit purchase (WOP-447). */
  reactivatedBots?: string[];
  /** True when this event was a duplicate / replay. */
  duplicate?: boolean;
  /** Bonus cents granted to referred user on first purchase (WOP-950). */
  affiliateBonusCents?: number;
}

/**
 * Dependencies required by the webhook handler.
 */
export interface WebhookDeps {
  tenantStore: TenantCustomerStore;
  creditLedger: CreditLedger;
  /** Map of Stripe Price ID -> CreditPricePoint for bonus calculation. */
  priceMap?: CreditPriceMap;
  /** Bot billing manager for reactivation after credit purchase (WOP-447). */
  botBilling?: BotBilling;
  /** Replay attack guard — rejects duplicate event IDs within TTL window. */
  replayGuard?: IWebhookSeenRepository;
  /** Affiliate repository for new-user bonus (WOP-950). */
  affiliateRepo?: IAffiliateRepository;
}

/**
 * Process a Stripe webhook event.
 *
 * Handles the events WOPR cares about:
 * - checkout.session.completed — record customer mapping and credit the ledger
 *
 * All other event types are acknowledged but not processed.
 * No subscription events are handled — WOPR uses credits, not subscriptions.
 */
export function handleWebhookEvent(deps: WebhookDeps, event: Stripe.Event): WebhookResult {
  // Replay guard: reject duplicate event IDs within the TTL window.
  if (deps.replayGuard?.isDuplicate(event.id, "stripe")) {
    return { handled: true, event_type: event.type, duplicate: true };
  }

  // Process the event based on type.
  let result: WebhookResult;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenant = session.client_reference_id ?? session.metadata?.wopr_tenant;

      if (!tenant || !session.customer) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const customerId = typeof session.customer === "string" ? session.customer : session.customer.id;

      // Upsert tenant-to-customer mapping (no subscription).
      deps.tenantStore.upsert({
        tenant,
        stripeCustomerId: customerId,
      });

      // Determine credit amount from price metadata or payment amount.
      const amountPaid = session.amount_total; // in cents
      if (amountPaid == null || amountPaid <= 0) {
        result = { handled: true, event_type: event.type, tenant, creditedCents: 0 };
        break;
      }

      // Idempotency: skip if this session was already processed.
      const stripeSessionId = session.id ?? "unknown";
      if (deps.creditLedger.hasReferenceId(stripeSessionId)) {
        result = { handled: true, event_type: event.type, tenant, creditedCents: 0 };
        break;
      }

      let creditCents: number;

      // Try to look up from price map first (has exact bonus tiers).
      if (deps.priceMap && deps.priceMap.size > 0) {
        // Match the paid amount against known tiers in the price map.
        let matched: number | null = null;
        for (const point of deps.priceMap.values()) {
          if (point.amountCents === amountPaid) {
            matched = point.creditCents;
            break;
          }
        }
        creditCents = matched ?? amountPaid;
      } else {
        // Fallback: 1:1 credit for the amount paid.
        creditCents = amountPaid;
      }

      // Credit the ledger with session ID as reference for idempotency.
      deps.creditLedger.credit(
        tenant,
        creditCents,
        "purchase",
        `Stripe credit purchase (session: ${stripeSessionId})`,
        stripeSessionId,
        "stripe",
      );

      // New-user first-purchase bonus for referred users (WOP-950).
      let affiliateBonusCents: number | undefined;
      if (deps.affiliateRepo) {
        const bonusResult = grantNewUserBonus({
          ledger: deps.creditLedger,
          affiliateRepo: deps.affiliateRepo,
          referredTenantId: tenant,
          purchaseAmountCents: creditCents,
        });
        if (bonusResult.granted) {
          affiliateBonusCents = bonusResult.bonusCents;
        }
      }

      // Reactivate suspended bots now that balance is positive (WOP-447).
      let reactivatedBots: string[] | undefined;
      if (deps.botBilling) {
        reactivatedBots = deps.botBilling.checkReactivation(tenant, deps.creditLedger);
        if (reactivatedBots.length === 0) reactivatedBots = undefined;
      }

      result = {
        handled: true,
        event_type: event.type,
        tenant,
        creditedCents: creditCents,
        reactivatedBots,
        affiliateBonusCents,
      };
      break;
    }

    default:
      result = { handled: false, event_type: event.type };
      break;
  }

  // Mark event as seen AFTER processing (success or failure) to prevent infinite retries.
  // This ensures that if processing throws an exception, the event can be retried,
  // but if processing completes (even with handled:false), duplicates are blocked.
  deps.replayGuard?.markSeen(event.id, "stripe");

  return result;
}
