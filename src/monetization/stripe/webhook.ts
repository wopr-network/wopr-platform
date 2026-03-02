import type Stripe from "stripe";
import { logger } from "../../config/logger.js";
import type { NotificationService } from "../../email/notification-service.js";
import type { IVpsRepository } from "../../fleet/vps-repository.js";
import { processAffiliateCreditMatch } from "../affiliate/credit-match.js";
import type { IAffiliateRepository } from "../affiliate/drizzle-affiliate-repository.js";
import { grantNewUserBonus } from "../affiliate/new-user-bonus.js";
import { Credit } from "../credit.js";
import type { BotBilling } from "../credits/bot-billing.js";
import type { CreditLedger } from "../credits/credit-ledger.js";
import type { PromotionEngine } from "../promotions/engine.js";
import type { IWebhookSeenRepository } from "../webhook-seen-repository.js";
import type { CreditPriceMap } from "./credit-prices.js";
import type { TenantCustomerRepository } from "./tenant-store.js";

/**
 * Result of processing a Stripe webhook event.
 */
export interface WebhookResult {
  handled: boolean;
  event_type: string;
  tenant?: string;
  /** Credits granted in cents (for checkout.session.completed). */
  creditedCents?: number;
  /** Credits debited in cents (for charge.refunded). */
  debitedCents?: number;
  /** Bot IDs reactivated after credit purchase (WOP-447). */
  reactivatedBots?: string[];
  /** Bot IDs suspended after payment failure (WOP-1289). */
  suspendedBots?: string[];
  /** True when this event was a duplicate / replay. */
  duplicate?: boolean;
  /** Bonus credits granted to referred user on first purchase (WOP-950). */
  affiliateBonus?: Credit;
  /** Stripe dispute ID when processing charge.dispute.created/closed (WOP-1303). */
  disputeId?: string;
}

/**
 * Dependencies required by the webhook handler.
 */
export interface WebhookDeps {
  tenantRepo: TenantCustomerRepository;
  creditLedger: CreditLedger;
  /** Map of Stripe Price ID -> CreditPricePoint for bonus calculation. */
  priceMap?: CreditPriceMap;
  /** Bot billing manager for reactivation after credit purchase (WOP-447). */
  botBilling?: BotBilling;
  /** Replay attack guard — rejects duplicate event IDs within TTL window. */
  replayGuard: IWebhookSeenRepository;
  /** Affiliate repository for credit match (WOP-949) and new-user bonus (WOP-950). */
  affiliateRepo?: IAffiliateRepository;
  /** Notification service for sending affiliate credit match emails (WOP-949). */
  notificationService?: NotificationService;
  /** Look up email address for a tenant ID (required for affiliate match notifications). */
  getEmailForTenant?: (tenantId: string) => string | null;
  /** VPS repository for subscription lifecycle (WOP-741). */
  vpsRepo?: IVpsRepository;
  /** Promotion engine for bonus_on_purchase grants. */
  promotionEngine?: PromotionEngine;
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
  if (await deps.replayGuard.isDuplicate(event.id, "stripe")) {
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
      await deps.tenantRepo.upsert({
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
          const referrerEmail = deps.getEmailForTenant(matchResult.referrerTenantId);
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

      // Fire bonus_on_purchase promotions (non-fatal).
      if (deps.promotionEngine) {
        try {
          await deps.promotionEngine.evaluateAndGrant({
            tenantId: tenant,
            trigger: "purchase",
            purchaseAmountCredits: Credit.fromCents(creditCents),
          });
        } catch (err) {
          logger.error("Promotion engine error in Stripe webhook — non-fatal", { err });
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
      await deps.tenantRepo.upsert({ tenant, processorCustomerId: customerId });

      const existing = await deps.vpsRepo.getByBotId(botId);
      if (subscription.status === "active") {
        if (!existing) {
          await deps.vpsRepo.create({
            botId,
            tenantId: tenant,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: customerId,
            hostname: `${tenant}.bot.${process.env.PLATFORM_DOMAIN ?? "wopr.bot"}`,
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

    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const tenant = pi.metadata?.wopr_tenant;

      if (!tenant || !pi.amount || pi.amount <= 0) {
        result = { handled: false, event_type: event.type };
        break;
      }

      // Idempotent: skip if inline grant in chargeAutoTopup() already credited this PI.
      if (await deps.creditLedger.hasReferenceId(pi.id)) {
        result = { handled: true, event_type: event.type, tenant, creditedCents: 0 };
        break;
      }

      // Fallback grant — inline path failed or process crashed before granting.
      const source = pi.metadata?.wopr_source ?? "auto_topup_webhook_fallback";
      await deps.creditLedger.credit(
        tenant,
        Credit.fromCents(pi.amount),
        "purchase",
        `Auto-topup webhook fallback (${source})`,
        pi.id,
        "stripe",
      );

      result = {
        handled: true,
        event_type: event.type,
        tenant,
        creditedCents: pi.amount,
      };
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : (invoice.customer as Stripe.Customer)?.id;

      if (!customerId) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const mapping = await deps.tenantRepo.getByProcessorCustomerId(customerId);
      if (!mapping) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const tenant = mapping.tenant;

      // Suspend all bots for this tenant (non-fatal if botBilling not provided).
      let suspendedBots: string[] | undefined;
      if (deps.botBilling) {
        suspendedBots = await deps.botBilling.suspendAllForTenant(tenant);
        if (suspendedBots.length === 0) suspendedBots = undefined;
      }

      // Send payment_failed notification (non-fatal).
      if (deps.notificationService && deps.getEmailForTenant) {
        const email = deps.getEmailForTenant(tenant);
        if (email) {
          deps.notificationService.notifyAutoTopUpFailed(tenant, email);
        }
      }

      logger.warn("Invoice payment failed", { tenant, customerId, invoiceId: invoice.id });

      result = { handled: true, event_type: event.type, tenant, suspendedBots };
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : (invoice.customer as Stripe.Customer)?.id;

      if (!customerId) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const mapping = await deps.tenantRepo.getByProcessorCustomerId(customerId);
      if (!mapping) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const tenant = mapping.tenant;
      const amountPaid = (invoice as unknown as { amount_paid?: number }).amount_paid;

      if (amountPaid == null || amountPaid <= 0) {
        result = { handled: true, event_type: event.type, tenant, creditedCents: 0 };
        break;
      }

      // Idempotency: skip if this invoice was already credited.
      if (await deps.creditLedger.hasReferenceId(invoice.id)) {
        result = { handled: true, event_type: event.type, tenant, creditedCents: 0 };
        break;
      }

      await deps.creditLedger.credit(
        tenant,
        Credit.fromCents(amountPaid),
        "purchase",
        `Stripe subscription renewal (invoice: ${invoice.id})`,
        invoice.id,
        "stripe",
      );

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
        creditedCents: amountPaid,
        reactivatedBots,
      };
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const customerId =
        typeof charge.customer === "string" ? charge.customer : (charge.customer as Stripe.Customer)?.id;
      const refundedCents = charge.amount_refunded;

      if (!customerId || !refundedCents || refundedCents <= 0) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const mapping = await deps.tenantRepo.getByProcessorCustomerId(customerId);
      if (!mapping) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const tenant = mapping.tenant;

      // Idempotency: skip if this charge was already refunded in the ledger.
      if (await deps.creditLedger.hasReferenceId(charge.id)) {
        result = { handled: true, event_type: event.type, tenant, debitedCents: 0 };
        break;
      }

      // Debit the ledger. Allow negative balance — refund must always succeed.
      await deps.creditLedger.debit(
        tenant,
        Credit.fromCents(refundedCents),
        "refund",
        `Stripe refund (charge: ${charge.id})`,
        charge.id,
        true, // allowNegative
      );

      logger.warn("Charge refunded — credits debited", { tenant, customerId, chargeId: charge.id, refundedCents });

      result = { handled: true, event_type: event.type, tenant, debitedCents: refundedCents };
      break;
    }

    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      // customer is not directly on Dispute — extract from the expanded charge object.
      const disputeCharge = dispute.charge as Stripe.Charge | string | null;
      const customerId =
        disputeCharge && typeof disputeCharge !== "string"
          ? typeof disputeCharge.customer === "string"
            ? disputeCharge.customer
            : ((disputeCharge.customer as Stripe.Customer | null)?.id ?? null)
          : null;

      if (!customerId) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const mapping = await deps.tenantRepo.getByProcessorCustomerId(customerId);
      if (!mapping) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const tenant = mapping.tenant;
      const disputeId = dispute.id;
      const disputedCents = dispute.amount;

      // Set billing hold — prevents further spend during dispute.
      await deps.tenantRepo.setBillingHold(tenant, true);

      // Debit disputed amount (allow negative). Idempotent via disputeId.
      if (disputedCents > 0 && !(await deps.creditLedger.hasReferenceId(disputeId))) {
        await deps.creditLedger.debit(
          tenant,
          Credit.fromCents(disputedCents),
          "correction",
          `Stripe dispute (dispute: ${disputeId}, reason: ${dispute.reason})`,
          disputeId,
          true, // allowNegative
        );
      }

      // Suspend all bots (non-fatal if botBilling not provided).
      let suspendedBots: string[] | undefined;
      if (deps.botBilling) {
        suspendedBots = await deps.botBilling.suspendAllForTenant(tenant);
        if (suspendedBots.length === 0) suspendedBots = undefined;
      }

      // Send admin alert notification (non-fatal).
      if (deps.notificationService && deps.getEmailForTenant) {
        const email = deps.getEmailForTenant(tenant);
        if (email) {
          const amountDollars = `$${(disputedCents / 100).toFixed(2)}`;
          deps.notificationService.notifyDisputeCreated(tenant, email, disputeId, amountDollars, dispute.reason);
        }
      }

      logger.warn("Charge dispute created — credits frozen, bots suspended", {
        tenant,
        customerId,
        disputeId,
        disputedCents,
        reason: dispute.reason,
      });

      result = { handled: true, event_type: event.type, tenant, disputeId, suspendedBots };
      break;
    }

    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      // customer is not directly on Dispute — extract from the expanded charge object.
      const disputeCharge2 = dispute.charge as Stripe.Charge | string | null;
      const customerId =
        disputeCharge2 && typeof disputeCharge2 !== "string"
          ? typeof disputeCharge2.customer === "string"
            ? disputeCharge2.customer
            : ((disputeCharge2.customer as Stripe.Customer | null)?.id ?? null)
          : null;

      if (!customerId) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const mapping = await deps.tenantRepo.getByProcessorCustomerId(customerId);
      if (!mapping) {
        result = { handled: false, event_type: event.type };
        break;
      }

      const tenant = mapping.tenant;
      const disputeId = dispute.id;
      const disputedCents = dispute.amount;

      if (dispute.status === "won") {
        // Dispute won — unfreeze hold and restore credits.
        await deps.tenantRepo.setBillingHold(tenant, false);

        // Re-credit the disputed amount. Idempotent via reversal referenceId.
        const reversalRef = `${disputeId}:reversal`;
        if (disputedCents > 0 && !(await deps.creditLedger.hasReferenceId(reversalRef))) {
          await deps.creditLedger.credit(
            tenant,
            Credit.fromCents(disputedCents),
            "correction",
            `Stripe dispute won — credits restored (dispute: ${disputeId})`,
            reversalRef,
            "stripe",
          );
        }

        // Reactivate bots (non-fatal).
        let reactivatedBots: string[] | undefined;
        if (deps.botBilling) {
          reactivatedBots = await deps.botBilling.checkReactivation(tenant, deps.creditLedger);
          if (reactivatedBots.length === 0) reactivatedBots = undefined;
        }

        // Send dispute-won notification (non-fatal).
        if (deps.notificationService && deps.getEmailForTenant) {
          const email = deps.getEmailForTenant(tenant);
          if (email) {
            const amountDollars = `$${(disputedCents / 100).toFixed(2)}`;
            deps.notificationService.notifyDisputeWon(tenant, email, disputeId, amountDollars);
          }
        }

        logger.info("Charge dispute won — credits unfrozen, bots reactivated", {
          tenant,
          customerId,
          disputeId,
          disputedCents,
        });

        result = { handled: true, event_type: event.type, tenant, disputeId, reactivatedBots };
      } else {
        // Dispute lost or other terminal status — hold stays, credits remain debited.
        // Send admin alert so the hold doesn't silently linger with no visibility.
        if (deps.notificationService && deps.getEmailForTenant) {
          const email = deps.getEmailForTenant(tenant);
          if (email) {
            const amountDollars = `$${(disputedCents / 100).toFixed(2)}`;
            deps.notificationService.notifyDisputeLost(tenant, email, disputeId, amountDollars);
          }
        }

        logger.warn("Charge dispute closed (not won)", {
          tenant,
          customerId,
          disputeId,
          status: dispute.status,
        });

        result = { handled: true, event_type: event.type, tenant, disputeId };
      }
      break;
    }

    default:
      result = { handled: false, event_type: event.type };
      break;
  }

  // Mark event as seen AFTER processing (success or failure) to prevent infinite retries.
  // This ensures that if processing throws an exception, the event can be retried,
  // but if processing completes (even with handled:false), duplicates are blocked.
  await deps.replayGuard.markSeen(event.id, "stripe");

  return result;
}
