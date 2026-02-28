import type { Credit } from "./credit.js";

/** Thrown when a tenant tries to detach a payment method they don't own. */
export class PaymentMethodOwnershipError extends Error {
  readonly code = "PAYMENT_METHOD_NOT_OWNED" as const;
  constructor() {
    super("Payment method does not belong to this tenant");
    this.name = "PaymentMethodOwnershipError";
  }
}

/** A saved payment method on file for a tenant (processor-agnostic). */
export interface SavedPaymentMethod {
  /** Processor-specific payment method ID (e.g. Stripe pm_xxx, PayRam wallet address). */
  id: string;
  /** Human-readable label (e.g. "Visa ending 4242", "ETH wallet"). */
  label: string;
  /** Whether this is the tenant's default payment method. */
  isDefault: boolean;
}

/** Options for creating a checkout session. */
export interface CheckoutOpts {
  /** Internal tenant ID. */
  tenant: string;
  /** Amount to charge. Required when no priceId is provided; may be omitted when priceId resolves the amount. */
  amount?: Credit;
  /** URL to redirect to after successful checkout. */
  successUrl: string;
  /** URL to redirect to if the user cancels checkout. */
  cancelUrl: string;
  /** Processor-specific price ID (e.g. Stripe price_xxx). Processors that don't use price IDs may ignore this. */
  priceId?: string;
}

/** Returned after creating a checkout session. */
export interface CheckoutSession {
  /** Processor-specific session ID (for idempotency / correlation). */
  id: string;
  /** URL to redirect the user to for payment. */
  url: string;
}

/** Options for charging a saved payment method off-session. */
export interface ChargeOpts {
  /** Internal tenant ID. */
  tenant: string;
  /** Amount to charge. */
  amount: Credit;
  /** Descriptive source tag for ledger entries (e.g. "auto_topup_usage"). */
  source: string;
}

/** Result of an off-session charge attempt. */
export interface ChargeResult {
  success: boolean;
  /** Processor-specific payment reference (e.g. Stripe PaymentIntent ID). */
  paymentReference?: string;
  error?: string;
}

/** Result of setting up a payment method for future use. */
export interface SetupResult {
  /** Processor-specific client secret for frontend completion (e.g. Stripe SetupIntent). */
  clientSecret: string;
}

/** Options for creating a billing portal session. */
export interface PortalOpts {
  /** Internal tenant ID. */
  tenant: string;
  /** URL to redirect to when the user is done managing billing. */
  returnUrl: string;
}

/** Result of processing an incoming webhook from a payment processor. */
export interface WebhookResult {
  handled: boolean;
  /** Processor-specific event type or status string. */
  eventType: string;
  tenant?: string;
  /** Credits to grant to the tenant's ledger. */
  credited?: Credit;
  /** Bot IDs reactivated after credit purchase (WOP-447). */
  reactivatedBots?: string[];
  /** True when this event was a duplicate / replay. */
  duplicate?: boolean;
}

/**
 * Processor-agnostic payment interface.
 *
 * Each payment processor (Stripe, PayRam, future processors) implements
 * this interface. The platform layer programs against IPaymentProcessor
 * and never imports processor-specific types.
 */
export interface IPaymentProcessor {
  /** Human-readable processor name (e.g. "stripe", "payram"). */
  readonly name: string;

  /** Create a checkout session for a one-time credit purchase. */
  createCheckoutSession(opts: CheckoutOpts): Promise<CheckoutSession>;

  /** Process an incoming webhook payload. */
  handleWebhook(payload: Buffer, signature: string): Promise<WebhookResult>;

  /** Whether this processor supports a self-service billing portal. */
  supportsPortal(): boolean;

  /**
   * Create a billing portal session (only if supportsPortal() is true).
   * Implementations that return false from supportsPortal() must throw rather than leaving this undefined.
   */
  createPortalSession(opts: PortalOpts): Promise<{ url: string }>;

  /** Save a payment method for future off-session charges. */
  setupPaymentMethod(tenant: string): Promise<SetupResult>;

  /** List saved payment methods for a tenant. */
  listPaymentMethods(tenant: string): Promise<SavedPaymentMethod[]>;

  /** Charge a saved payment method off-session. */
  charge(opts: ChargeOpts): Promise<ChargeResult>;

  /** Detach a payment method from the tenant's account. */
  detachPaymentMethod(tenant: string, paymentMethodId: string): Promise<void>;

  /** Get the billing email for a tenant's customer account. Returns "" if no customer exists. */
  getCustomerEmail(tenantId: string): Promise<string>;

  /** Update the billing email for a tenant's customer account. */
  updateCustomerEmail(tenantId: string, email: string): Promise<void>;
}
