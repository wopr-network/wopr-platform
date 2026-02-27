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
import { Credit } from "../monetization/credit.js";
import type { CreditLedger } from "../monetization/credits/credit-ledger.js";
import { InsufficientBalanceError } from "../monetization/credits/credit-ledger.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";

export interface CreditGateDeps {
  creditLedger?: CreditLedger;
  topUpUrl: string;
  /** Maximum negative balance allowed before hard-stop. Default: Credit.fromCents(50) (-$0.50). */
  graceBuffer?: Credit;
  /** Called when a debit causes balance to cross the zero threshold. */
  onBalanceExhausted?: (tenantId: string, newBalance: Credit) => void;
  /** Called after every successful debit (fire-and-forget auto-topup trigger). */
  onDebitComplete?: (tenantId: string) => void;
  metrics?: import("../observability/metrics.js").MetricsCollector;
}

export interface CreditError {
  message: string;
  type: string;
  code: string;
  needsCredits: boolean;
  topUpUrl: string;
  currentBalance: number;
  required: number;
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
export async function creditBalanceCheck(
  c: Context<GatewayAuthEnv>,
  deps: CreditGateDeps,
  estimatedCost: Credit = Credit.ZERO,
): Promise<CreditError | null> {
  if (!deps.creditLedger) return null;

  const tenant = c.get("gatewayTenant");
  const balance = await deps.creditLedger.balance(tenant.id);
  const graceBuffer = deps.graceBuffer ?? Credit.fromCents(50); // default -$0.50
  const negativeGrace = Credit.ZERO.subtract(graceBuffer);

  // Hard stop: balance has exceeded the grace buffer
  if (balance.lessThanOrEqual(negativeGrace)) {
    return {
      message: "Your credits are exhausted. Add credits to continue using your bot.",
      type: "billing_error",
      code: "credits_exhausted",
      needsCredits: true,
      topUpUrl: deps.topUpUrl,
      currentBalance: balance.toRaw(),
      required: estimatedCost.toRaw(),
    };
  }

  // Soft check: balance is positive but below estimated cost (no grace buffer needed yet)
  if (!balance.isNegative() && balance.lessThan(estimatedCost)) {
    return {
      message: "Insufficient credits. Please add credits to continue.",
      type: "billing_error",
      code: "insufficient_credits",
      needsCredits: true,
      topUpUrl: deps.topUpUrl,
      currentBalance: balance.toRaw(),
      required: estimatedCost.toRaw(),
    };
  }

  // Balance is negative but within grace buffer — allow through (auto-topup window)
  // Balance is positive and >= required — allow through
  return null;
}

/**
 * Post-call credit debit. Fire-and-forget — never fails the response.
 */
export async function debitCredits(
  deps: CreditGateDeps,
  tenantId: string,
  costUsd: number,
  margin: number,
  capability: string,
  provider: string,
  attributedUserId?: string,
): Promise<void> {
  if (!deps.creditLedger) return;

  const chargeCredit = withMargin(Credit.fromDollars(costUsd), margin);

  if (chargeCredit.isZero() || chargeCredit.isNegative()) return;

  try {
    await deps.creditLedger.debit(
      tenantId,
      chargeCredit,
      "adapter_usage",
      `Gateway ${capability} via ${provider}`,
      undefined,
      true,
      attributedUserId,
    );

    // Only fire on first zero-crossing (balance was positive before, now ≤ 0)
    if (deps.onBalanceExhausted) {
      const newBalance = await deps.creditLedger.balance(tenantId);
      const balanceBefore = newBalance.add(chargeCredit);
      if (balanceBefore.greaterThan(Credit.ZERO) && (newBalance.isNegative() || newBalance.isZero())) {
        deps.onBalanceExhausted(tenantId, newBalance);
      }
    }

    // Fire-and-forget: check if usage-based auto-topup should trigger
    if (deps.onDebitComplete) {
      deps.onDebitComplete(tenantId);
    }
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      logger.warn("Credit debit failed after proxy (insufficient balance)", {
        tenantId,
        chargeRaw: chargeCredit.toRaw(),
        currentBalance: error.currentBalance,
        capability,
        provider,
      });
      deps.metrics?.recordCreditDeductionFailure();
    } else {
      logger.error("Credit debit failed after proxy", {
        tenantId,
        chargeRaw: chargeCredit.toRaw(),
        capability,
        provider,
        error,
      });
      deps.metrics?.recordCreditDeductionFailure();
    }
  }
}
