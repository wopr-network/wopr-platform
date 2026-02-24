import type Stripe from "stripe";
import { Credit } from "../credit.js";
import { chargeAutoTopup } from "../credits/auto-topup-charge.js";
import type { IAutoTopupEventLogRepository } from "../credits/auto-topup-event-log-repository.js";
import type { BotBilling } from "../credits/bot-billing.js";
import type { ICreditLedger } from "../credits/credit-ledger.js";
import {
  type ChargeOpts,
  type ChargeResult,
  type CheckoutOpts,
  type CheckoutSession,
  type IPaymentProcessor,
  PaymentMethodOwnershipError,
  type PortalOpts,
  type SavedPaymentMethod,
  type SetupResult,
  type WebhookResult,
} from "../payment-processor.js";
import type { IWebhookSeenRepository } from "../webhook-seen-repository.js";
import { createCreditCheckoutSession } from "./checkout.js";
import type { CreditPriceMap } from "./credit-prices.js";
import { createPortalSession } from "./portal.js";
import { createSetupIntent } from "./setup-intent.js";
import type { ITenantCustomerStore } from "./tenant-store.js";
import { handleWebhookEvent } from "./webhook.js";

export interface StripePaymentProcessorDeps {
  stripe: Stripe;
  tenantStore: ITenantCustomerStore;
  webhookSecret: string;
  priceMap?: CreditPriceMap;
  creditLedger: ICreditLedger;
  botBilling?: BotBilling;
  replayGuard?: IWebhookSeenRepository;
  autoTopupEventLog?: IAutoTopupEventLogRepository;
}

export class StripePaymentProcessor implements IPaymentProcessor {
  readonly name = "stripe";

  private readonly stripe: Stripe;
  private readonly tenantStore: ITenantCustomerStore;
  private readonly webhookSecret: string;
  private readonly priceMap: CreditPriceMap;
  private readonly creditLedger: ICreditLedger;
  private readonly botBilling?: BotBilling;
  private readonly replayGuard?: IWebhookSeenRepository;
  private readonly autoTopupEventLog?: IAutoTopupEventLogRepository;

  constructor(deps: StripePaymentProcessorDeps) {
    this.stripe = deps.stripe;
    this.tenantStore = deps.tenantStore;
    this.webhookSecret = deps.webhookSecret;
    this.priceMap = deps.priceMap ?? new Map();
    this.creditLedger = deps.creditLedger;
    this.botBilling = deps.botBilling;
    this.replayGuard = deps.replayGuard;
    this.autoTopupEventLog = deps.autoTopupEventLog;
  }

  async createCheckoutSession(opts: CheckoutOpts): Promise<CheckoutSession> {
    let priceId: string | undefined = opts.priceId;

    if (!priceId) {
      // Fall back to looking up by amount when no explicit priceId provided.
      const amountCents = opts.amount instanceof Credit ? opts.amount.toCents() : Number(opts.amount);

      for (const [id, point] of this.priceMap.entries()) {
        if (point.creditCents === amountCents || point.amountCents === amountCents) {
          priceId = id;
          break;
        }
      }

      if (!priceId) {
        throw new Error(
          `No Stripe price tier matches amount ${amountCents} cents. Configure STRIPE_CREDIT_PRICE_* env vars.`,
        );
      }
    }

    const session = await createCreditCheckoutSession(
      this.stripe,
      this.tenantStore as Parameters<typeof createCreditCheckoutSession>[1],
      {
        tenant: opts.tenant,
        priceId,
        successUrl: opts.successUrl,
        cancelUrl: opts.cancelUrl,
      },
    );

    return {
      id: session.id,
      url: session.url ?? "",
    };
  }

  async handleWebhook(payload: Buffer, signature: string): Promise<WebhookResult> {
    const event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);

    const result = handleWebhookEvent(
      {
        tenantStore: this.tenantStore as Parameters<typeof handleWebhookEvent>[0]["tenantStore"],
        creditLedger: this.creditLedger as Parameters<typeof handleWebhookEvent>[0]["creditLedger"],
        priceMap: this.priceMap.size > 0 ? this.priceMap : undefined,
        botBilling: this.botBilling,
        replayGuard: this.replayGuard,
      },
      event,
    );

    return {
      handled: result.handled,
      eventType: result.event_type,
      tenant: result.tenant,
      credited: result.creditedCents != null ? Credit.fromCents(result.creditedCents) : undefined,
      reactivatedBots: result.reactivatedBots,
      duplicate: result.duplicate,
    };
  }

  supportsPortal(): boolean {
    return true;
  }

  async createPortalSession(opts: PortalOpts): Promise<{ url: string }> {
    const session = await createPortalSession(
      this.stripe,
      this.tenantStore as Parameters<typeof createPortalSession>[1],
      {
        tenant: opts.tenant,
        returnUrl: opts.returnUrl,
      },
    );

    return { url: session.url };
  }

  async setupPaymentMethod(tenant: string): Promise<SetupResult> {
    const intent = await createSetupIntent(this.stripe, this.tenantStore as Parameters<typeof createSetupIntent>[1], {
      tenant,
    });

    return {
      clientSecret: intent.client_secret ?? "",
    };
  }

  async listPaymentMethods(tenant: string): Promise<SavedPaymentMethod[]> {
    const mapping = this.tenantStore.getByTenant(tenant);
    if (!mapping) {
      return [];
    }

    const methods = await this.stripe.customers.listPaymentMethods(mapping.processor_customer_id);

    return methods.data.map((pm, index) => ({
      id: pm.id,
      label: formatPaymentMethodLabel(pm),
      isDefault: index === 0,
    }));
  }

  async detachPaymentMethod(tenant: string, paymentMethodId: string): Promise<void> {
    const mapping = this.tenantStore.getByTenant(tenant);
    if (!mapping) {
      throw new Error(`No Stripe customer found for tenant: ${tenant}`);
    }

    const pm = await this.stripe.paymentMethods.retrieve(paymentMethodId);
    if (!pm.customer || pm.customer !== mapping.processor_customer_id) {
      throw new PaymentMethodOwnershipError();
    }

    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async charge(opts: ChargeOpts): Promise<ChargeResult> {
    if (!this.autoTopupEventLog) {
      throw new Error("autoTopupEventLog is required for charge()");
    }

    const amountCents = opts.amount instanceof Credit ? opts.amount.toCents() : Number(opts.amount);

    const result = await chargeAutoTopup(
      {
        stripe: this.stripe,
        tenantStore: this.tenantStore,
        creditLedger: this.creditLedger,
        eventLogRepo: this.autoTopupEventLog,
      },
      opts.tenant,
      amountCents,
      opts.source,
    );

    return {
      success: result.success,
      paymentReference: result.paymentReference,
      error: result.error,
    };
  }
}

function formatPaymentMethodLabel(pm: Stripe.PaymentMethod): string {
  if (pm.card) {
    const brand = pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1);
    return `${brand} ending ${pm.card.last4}`;
  }
  return `Payment method ${pm.id}`;
}
