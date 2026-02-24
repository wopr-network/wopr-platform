import { logger } from "../../config/logger.js";
import { withMargin } from "../adapters/types.js";
import type { IMeterEmitter } from "../metering/emitter.js";
import type { ICreditLedger } from "./credit-ledger.js";
import { InsufficientBalanceError } from "./credit-ledger.js";
import type { IPhoneNumberRepository } from "./drizzle-phone-number-repository.js";

export type { IPhoneNumberRepository } from "./drizzle-phone-number-repository.js";

/** Phone number monthly wholesale cost in USD. Exported for proxy.ts to import. */
export const PHONE_NUMBER_MONTHLY_COST = 1.15;

/** Billing margin multiplier for phone numbers. */
const PHONE_NUMBER_MARGIN = 2.6;

export async function runMonthlyPhoneBilling(
  phoneRepo: IPhoneNumberRepository,
  ledger: ICreditLedger,
  meter: IMeterEmitter,
): Promise<{
  processed: number;
  billed: { tenantId: string; sid: string; cost: number }[];
  failed: { tenantId: string; error: string }[];
}> {
  const result = {
    processed: 0,
    billed: [] as { tenantId: string; sid: string; cost: number }[],
    failed: [] as { tenantId: string; error: string }[],
  };

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const activeNumbers = await phoneRepo.listActivePhoneNumbers();

  for (const number of activeNumbers) {
    result.processed++;

    const lastBilled = number.lastBilledAt ?? number.provisionedAt;
    if (lastBilled > thirtyDaysAgo.toISOString()) {
      continue;
    }

    try {
      const chargeUsd = withMargin(PHONE_NUMBER_MONTHLY_COST, PHONE_NUMBER_MARGIN);
      const chargeCents = Math.ceil(chargeUsd * 100);

      ledger.debit(
        number.tenantId,
        chargeCents,
        "addon",
        "Monthly phone number fee",
        `phone-billing:${number.sid}:${now.toISOString().slice(0, 7)}`,
        true,
      );

      meter.emit({
        tenant: number.tenantId,
        cost: PHONE_NUMBER_MONTHLY_COST,
        charge: chargeUsd,
        capability: "phone-number-monthly",
        provider: "twilio",
        timestamp: now.getTime(),
        usage: { units: 1, unitType: "numbers" },
        tier: "branded",
        metadata: { sid: number.sid },
      });

      await phoneRepo.markBilled(number.sid);

      logger.info("Monthly phone billing", {
        tenantId: number.tenantId,
        sid: number.sid,
        cost: PHONE_NUMBER_MONTHLY_COST,
      });

      result.billed.push({
        tenantId: number.tenantId,
        sid: number.sid,
        cost: PHONE_NUMBER_MONTHLY_COST,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof InsufficientBalanceError) {
        logger.warn("Monthly phone billing skipped: insufficient balance", {
          tenantId: number.tenantId,
          sid: number.sid,
        });
      } else {
        logger.error("Monthly phone billing failed", {
          tenantId: number.tenantId,
          sid: number.sid,
          error: msg,
        });
      }
      result.failed.push({ tenantId: number.tenantId, error: msg });
    }
  }

  return result;
}
