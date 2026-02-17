/** PayRam payment states (from PayRam API docs). */
export type PayRamPaymentState = "OPEN" | "VERIFYING" | "FILLED" | "OVER_FILLED" | "PARTIALLY_FILLED" | "CANCELLED";

/** Options for creating a PayRam payment session. */
export interface PayRamCheckoutOpts {
  /** Internal tenant ID. */
  tenant: string;
  /** Amount in USD (minimum $10). */
  amountUsd: number;
}

/** Webhook payload received from PayRam. */
export interface PayRamWebhookPayload {
  /** Unique payment reference from session creation. */
  reference_id: string;
  /** Merchant invoice ID (echoed back if sent). */
  invoice_id?: string;
  /** Payment status. */
  status: PayRamPaymentState;
  /** Amount filled in this update. */
  amount: string;
  /** Currency symbol (ETH, USDC, USDT, etc.). */
  currency: string;
  /** Cumulative total filled so far. */
  filled_amount: string;
}

/** Configuration for PayRam billing integration. */
export interface PayRamBillingConfig {
  /** PayRam API key (from dashboard). */
  apiKey: string;
  /** PayRam self-hosted server base URL. */
  baseUrl: string;
}

/** Result of processing a PayRam webhook event. */
export interface PayRamWebhookResult {
  handled: boolean;
  status: string;
  tenant?: string;
  creditedCents?: number;
  reactivatedBots?: string[];
  duplicate?: boolean;
}
