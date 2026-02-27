import type Stripe from "stripe";
import type { NotificationService } from "../../email/notification-service.js";
import type { IVpsRepository } from "../../fleet/vps-repository.js";
import { processAffiliateCreditMatch } from "../affiliate/credit-match.js";
import type { IAffiliateRepository } from "../affiliate/drizzle-affiliate-repository.js";
import { grantNewUserBonus } from "../affiliate/new-user-bonus.js";
import { Credit } from "../credit.js";
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
  /** Bonus credits granted to referred user on first purchase (WOP-950). */
  affiliateBonus?: Credit;
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
  /** Affiliate repository for credit match (WOP-949) and new-user bonus (WOP-950). */
  affiliateRepo?: IAffiliateRepository;
  /** Notification service for sending affiliate credit match emails (WOP-949). */
  notificationService?: NotificationService;
  /** Look up email address for a tenant ID (required for affiliate match notifications). */
  getEmailForTenant?: (tenantId: string) => string | null;
  /** VPS repository for subscription lifecycle (WOP-741). */
  vpsRepo?: IVpsRepository;
}

/**
 * Process a Stripe webhook event.
 *
 * Handles the events WOPR cares about:
 * - checkout.session.completed — record customer mapping and credit the ledger
 * - customer.subscription.created/updated — activate VPS tier for bot (WOP-741)
 * - customer.subscription.deleted — cancel VPS tier for bot (WOP-741)
 *
 * All other event types are acknowledged but not processed.
 * Credit-based events use mode: "payment"; VPS subscription events use mode: "subscription".
 */
export async function handleWebhookEvent(deps: WebhookDeps, event: Stripe.Event): Promise<WebhookResult> {
  // Replay guard: reject duplicate event IDs within the TTL window.
  if (await deps.replayGuard?.isDuplicate(event.id, "stripe")) {
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
      await deps.tenantStore.upsert({
        tenant,
        processorCustomerId: customerId,
      });

      // Determine credit amount from price metadata or payment amount.
      const amountPaid = session.amount_total; // in cents
      if (amountPaid == null || amountPaid <= 0) {
        result = { handled: true, event_type: event.type, tenant, creditedCents: 0 };
        break;
      }

      // Idempotency: skip if this session was already processed.
      const stripeSessionId = session.id ?? "unknown";
      if (await deps.creditLedger.hasReferenceId(stripeSessionId)) {
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
      await deps.creditLedger.credit(
        tenant,
        Credit.fromCents(creditCents),
        "purchase",
        `Stripe credit purchase (session: ${stripeSessionId})`,
        stripeSessionId,
        "stripe",
      );

      // New-user first-purchase bonus for referred users (WOP-950).
      // Must run before credit match so markFirstPurchase hasn't been called yet.
      let affiliateBonusCredit: Credit | undefined;
      if (deps.affiliateRepo) {
        const bonusResult = await grantNewUserBonus({
          ledger: deps.creditLedger,
          affiliateRepo: deps.affiliateRepo,
          referredTenantId: tenant,
          purchaseAmount: Credit.fromCents(creditCents),
        });
        if (bonusResult.granted) {
          affiliateBonusCredit = bonusResult.bonus;
        }
      }

      // Affiliate credit match — grant referrer matching credits on first purchase (WOP-949).
      if (deps.affiliateRepo) {
        const matchResult = await processAffiliateCreditMatch({
          tenantId: tenant,
          purchaseAmount: Credit.fromCents(creditCents),
          ledger: deps.creditLedger,
          affiliateRepo: deps.affiliateRepo,
        });
        if (matchResult && deps.notificationService && deps.getEmailForTenant) {
          const referrerEmail = await deps.getEmailForTenant(matchResult.referrerTenantId);
          if (referrerEmail) {
            const amountDollars = (matchResult.matchAmount.toCents() / 100).toFixed(2);
            deps.notificationService.notifyAffiliateCreditMatch(
              matchResult.referrerTenantId,
              referrerEmail,
              amountDollars,
            );
          }
        }
      }

      // Reactivate suspended bots now that balance is positive (WOP-447).
      let reactivatedBots: string[] | undefined;
      if (deps.botBilling) {
        reactivatedBots = await deps.botBilling.checkReactivation(tenant, deps.creditLedger);
        if (reactivatedBots.length === 0) reactivatedBots = undefined;
      }

      result = {
        handled: true,
        event_type: event.type,
        tenant,
        creditedCents: creditCents,
        reactivatedBots,
        affiliateBonus: affiliateBonusCredit,
      };
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const botId = subscription.metadata?.wopr_bot_id;
      const tenant = subscription.metadata?.wopr_tenant;
      const purchaseType = subscription.metadata?.wopr_purchase_type;

      if (!botId || !tenant || purchaseType !== "vps" || !deps.vpsRepo) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

      // Upsert tenant-customer mapping.
      await deps.tenantStore.upsert({ tenant, processorCustomerId: customerId });

      const existing = await deps.vpsRepo.getByBotId(botId);
      if (subscription.status === "active") {
        if (!existing) {
          await deps.vpsRepo.create({
            botId,
            tenantId: tenant,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: customerId,
            hostname: `${tenant}.bot.wopr.bot`,
          });
        } else {
          await deps.vpsRepo.updateStatus(botId, "active");
        }
      } else if (subscription.status === "canceled") {
        if (existing) {
          await deps.vpsRepo.updateStatus(botId, "canceled");
        }
      } else if (subscription.cancel_at_period_end) {
        if (existing) {
          await deps.vpsRepo.updateStatus(botId, "canceling");
        }
      }

      result = { handled: true, event_type: event.type, tenant };
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const botId = subscription.metadata?.wopr_bot_id;

      if (!botId || !deps.vpsRepo) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const existing2 = await deps.vpsRepo.getByBotId(botId);
      if (existing2) {
        await deps.vpsRepo.updateStatus(botId, "canceled");
      }

      result = {
        handled: true,
        event_type: event.type,
        tenant: subscription.metadata?.wopr_tenant,
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
  await deps.replayGuard?.markSeen(event.id, "stripe");

  return result;
}
