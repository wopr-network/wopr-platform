/**
 * Gateway credit gate — shared helpers for credit balance checks and debits.
 *
 * Used by both the main proxy handlers and the protocol-specific handlers
 * (OpenAI, Anthropic) to ensure consistent credit billing across all
 * gateway endpoints.
 */

import type { Context } from "hono";
import { logger } from "../config/logger.js";
import { withMargin } from "../monetization/adapters/types.js";
import type { CreditLedger } from "../monetization/credits/credit-ledger.js";
import { InsufficientBalanceError } from "../monetization/credits/credit-ledger.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";

export interface CreditGateDeps {
  creditLedger?: CreditLedger;
  topUpUrl: string;
  /** Maximum negative balance allowed before hard-stop, in cents. Default: 50 (-$0.50). */
  graceBufferCents?: number;
  /** Called when a debit causes balance to cross the zero threshold. */
  onBalanceExhausted?: (tenantId: string, newBalanceCents: number) => void;
  metrics?: import("../observability/metrics.js").MetricsCollector;
}

export interface CreditError {
  message: string;
  type: string;
  code: string;
  needsCredits: boolean;
  topUpUrl: string;
  currentBalanceCents: number;
  requiredCents: number;
}

/**
 * Pre-call credit balance check.
 * Returns a structured error object if credits are insufficient, or null if OK.
 *
 * IMPORTANT: This check is NOT atomic with the debit call. Concurrent requests
 * can both pass this check, then one debit may fail. This is an accepted trade-off:
 * we prefer fire-and-forget debits (logged but not failing the response) over locking.
 * Reconciliation via ledger queries catches discrepancies.
 */
export function creditBalanceCheck(
  c: Context<GatewayAuthEnv>,
  deps: CreditGateDeps,
  estimatedCostCents: number = 0,
): CreditError | null {
  if (!deps.creditLedger) return null;

  const tenant = c.get("gatewayTenant");
  const balance = deps.creditLedger.balance(tenant.id);
  const required = Math.max(0, estimatedCostCents);
  const graceBuffer = deps.graceBufferCents ?? 50; // default -$0.50

  // Hard stop: balance has exceeded the grace buffer
  if (balance <= -graceBuffer) {
    return {
      message: "Your credits are exhausted. Add credits to continue using your bot.",
      type: "billing_error",
      code: "credits_exhausted",
      needsCredits: true,
      topUpUrl: deps.topUpUrl,
      currentBalanceCents: balance,
      requiredCents: required,
    };
  }

  // Soft check: balance is positive but below estimated cost (no grace buffer needed yet)
  if (balance >= 0 && balance < required) {
    return {
      message: "Insufficient credits. Please add credits to continue.",
      type: "billing_error",
      code: "insufficient_credits",
      needsCredits: true,
      topUpUrl: deps.topUpUrl,
      currentBalanceCents: balance,
      requiredCents: required,
    };
  }

  // Balance is negative but within grace buffer — allow through (auto-topup window)
  // Balance is positive and >= required — allow through
  return null;
}

/**
 * Post-call credit debit. Fire-and-forget — never fails the response.
 */
export function debitCredits(
  deps: CreditGateDeps,
  tenantId: string,
  costUsd: number,
  margin: number,
  capability: string,
  provider: string,
): void {
  if (!deps.creditLedger) return;

  const chargeUsd = withMargin(costUsd, margin);
  const chargeCents = Math.ceil(chargeUsd * 100);

  if (chargeCents <= 0) return;

  try {
    deps.creditLedger.debit(
      tenantId,
      chargeCents,
      "adapter_usage",
      `Gateway ${capability} via ${provider}`,
      undefined,
      true,
    );

    // Only fire on first zero-crossing (balance was positive before, now ≤ 0)
    if (deps.onBalanceExhausted) {
      const newBalance = deps.creditLedger.balance(tenantId);
      const balanceBefore = newBalance + chargeCents;
      if (balanceBefore > 0 && newBalance <= 0) {
        deps.onBalanceExhausted(tenantId, newBalance);
      }
    }
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      logger.warn("Credit debit failed after proxy (insufficient balance)", {
        tenantId,
        chargeCents,
        currentBalance: error.currentBalance,
        capability,
        provider,
      });
      deps.metrics?.recordCreditDeductionFailure();
    } else {
      logger.error("Credit debit failed after proxy", {
        tenantId,
        chargeCents,
        capability,
        provider,
        error,
      });
      deps.metrics?.recordCreditDeductionFailure();
    }
  }
}
