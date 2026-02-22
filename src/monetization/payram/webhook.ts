import type { BotBilling } from "../credits/bot-billing.js";
import type { CreditLedger } from "../credits/credit-ledger.js";
import type { IWebhookSeenRepository } from "../webhook-seen-repository.js";
import type { PayRamChargeStore } from "./charge-store.js";
import type { PayRamWebhookPayload, PayRamWebhookResult } from "./types.js";

export interface PayRamWebhookDeps {
  chargeStore: PayRamChargeStore;
  creditLedger: CreditLedger;
  botBilling?: BotBilling;
  replayGuard?: IWebhookSeenRepository;
}

/**
 * Process a PayRam webhook event.
 *
 * Only credits the ledger on FILLED or OVER_FILLED status.
 * Uses the PayRam reference_id mapped to the stored charge record
 * for tenant resolution and idempotency.
 */
export function handlePayRamWebhook(deps: PayRamWebhookDeps, payload: PayRamWebhookPayload): PayRamWebhookResult {
  const { chargeStore, creditLedger } = deps;

  // Replay guard: deduplicate by reference_id + status combination.
  const dedupeKey = `${payload.reference_id}:${payload.status}`;
  if (deps.replayGuard?.isDuplicate(dedupeKey, "payram")) {
    return { handled: true, status: payload.status, duplicate: true };
  }

  // Look up the charge record to find the tenant.
  const charge = chargeStore.getByReferenceId(payload.reference_id);
  if (!charge) {
    return { handled: false, status: payload.status };
  }

  // Update charge status regardless of payment state.
  chargeStore.updateStatus(payload.reference_id, payload.status, payload.currency, payload.filled_amount);

  let result: PayRamWebhookResult;

  if (payload.status === "FILLED" || payload.status === "OVER_FILLED") {
    // Idempotency: skip if already credited.
    if (chargeStore.isCredited(payload.reference_id)) {
      result = {
        handled: true,
        status: payload.status,
        tenant: charge.tenantId,
        creditedCents: 0,
      };
    } else {
      // Credit the original USD amount requested (not the crypto amount).
      // For OVER_FILLED, we still credit the requested amount — the
      // overpayment stays in the PayRam wallet as a buffer.
      const creditCents = charge.amountUsdCents;

      creditLedger.credit(
        charge.tenantId,
        creditCents,
        "purchase",
        `Crypto credit purchase via PayRam (ref: ${payload.reference_id}, ${payload.currency ?? "crypto"})`,
        `payram:${payload.reference_id}`,
        "payram",
      );

      chargeStore.markCredited(payload.reference_id);

      // Reactivate suspended bots (same as Stripe webhook, WOP-447).
      let reactivatedBots: string[] | undefined;
      if (deps.botBilling) {
        reactivatedBots = deps.botBilling.checkReactivation(charge.tenantId, creditLedger);
        if (reactivatedBots.length === 0) reactivatedBots = undefined;
      }

      result = {
        handled: true,
        status: payload.status,
        tenant: charge.tenantId,
        creditedCents: creditCents,
        reactivatedBots,
      };
    }
  } else {
    // OPEN, VERIFYING, PARTIALLY_FILLED, CANCELLED — just track status.
    result = {
      handled: true,
      status: payload.status,
      tenant: charge.tenantId,
    };
  }

  deps.replayGuard?.markSeen(dedupeKey, "payram");
  return result;
}
