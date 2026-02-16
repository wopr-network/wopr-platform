import { LRUCache } from "lru-cache";
import type Stripe from "stripe";
import type { CreditRepository } from "../../domain/repositories/credit-repository.js";
import type { TenantCustomerRepository } from "../../domain/repositories/tenant-customer-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import type { BotBilling } from "../credits/bot-billing.js";
import type { CreditPriceMap } from "./credit-prices.js";

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
}

/**
 * In-memory guard that rejects duplicate Stripe event IDs within a TTL window.
 * Uses LRU cache so memory stays bounded even under high throughput.
 */
export class WebhookReplayGuard {
  private readonly seen: LRUCache<string, true>;

  constructor(ttlMs = 5 * 60 * 1000, maxEntries = 10_000) {
    this.seen = new LRUCache<string, true>({ max: maxEntries, ttl: ttlMs });
  }

  /** Returns true if this event ID was already seen (replay). */
  isDuplicate(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** Mark an event ID as processed. */
  markSeen(eventId: string): void {
    this.seen.set(eventId, true);
  }
}

/**
 * Dependencies required by the webhook handler.
 */
export interface WebhookDeps {
  tenantRepo: TenantCustomerRepository;
  creditRepo: CreditRepository;
  /** Map of Stripe Price ID -> CreditPricePoint for bonus calculation. */
  priceMap?: CreditPriceMap;
  /** Bot billing manager for reactivation after credit purchase (WOP-447). */
  botBilling?: BotBilling;
  /** Replay attack guard — rejects duplicate event IDs within TTL window. */
  replayGuard?: WebhookReplayGuard;
}

/**
 * Process a Stripe webhook event.
 *
 * Handles the events WOPR cares about:
 * - checkout.session.completed — record customer mapping and credit the ledger
 *
 * All other event types are acknowledged but not processed.
 * No subscription events are handled — WOPR uses credits, not subscriptions.
 *
 * MIGRATED: Now uses CreditRepository (async) instead of CreditLedger (sync)
 */
export async function handleWebhookEvent(deps: WebhookDeps, event: Stripe.Event): Promise<WebhookResult> {
  // Replay guard: reject duplicate event IDs within the TTL window.
  if (deps.replayGuard?.isDuplicate(event.id)) {
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
      await deps.tenantRepo.upsert(TenantId.create(tenant), customerId);

      // Determine credit amount from price metadata or payment amount.
      const amountPaid = session.amount_total; // in cents
      if (amountPaid == null || amountPaid <= 0) {
        result = { handled: true, event_type: event.type, tenant, creditedCents: 0 };
        break;
      }

      // Idempotency: skip if this session was already processed.
      const stripeSessionId = session.id ?? "unknown";
      if (await deps.creditRepo.hasReferenceId(stripeSessionId)) {
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
      // MIGRATED: Use async CreditRepository
      const { Money } = await import("../../domain/value-objects/money.js");

      await deps.creditRepo.credit(
        TenantId.create(tenant),
        Money.fromCents(creditCents),
        "purchase",
        `Stripe credit purchase (session: ${stripeSessionId})`,
        stripeSessionId,
      );

      // Reactivate suspended bots now that balance is positive (WOP-447).
      // MIGRATED: BotBilling.checkReactivation now takes CreditRepository
      let reactivatedBots: string[] | undefined;
      if (deps.botBilling) {
        reactivatedBots = await deps.botBilling.checkReactivation(tenant, deps.creditRepo);
        if (reactivatedBots.length === 0) reactivatedBots = undefined;
      }

      result = { handled: true, event_type: event.type, tenant, creditedCents: creditCents, reactivatedBots };
      break;
    }

    default:
      result = { handled: false, event_type: event.type };
      break;
  }

  // Mark event as seen AFTER processing (success or failure) to prevent infinite retries.
  // This ensures that if processing throws an exception, the event can be retried,
  // but if processing completes (even with handled:false), duplicates are blocked.
  deps.replayGuard?.markSeen(event.id);

  return result;
}
