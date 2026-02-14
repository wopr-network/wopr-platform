import { logger } from "../../config/logger.js";
import type { CreditLedger } from "./credit-ledger.js";
import { InsufficientBalanceError } from "./credit-ledger.js";

/**
 * Bot runtime cost: $5/bot/month prorated daily.
 * $5.00 = 500 cents, 500 / 30 ≈ 16.67 cents/day, rounded to 17 cents.
 */
export const DAILY_BOT_COST_CENTS = 17;

/** Callback invoked when a tenant's balance hits zero during deduction. */
export type OnSuspend = (tenantId: string) => void | Promise<void>;

/** Resolve the number of active bots for a given tenant. */
export type GetActiveBotCount = (tenantId: string) => number | Promise<number>;

export interface RuntimeCronConfig {
  ledger: CreditLedger;
  getActiveBotCount: GetActiveBotCount;
  onSuspend?: OnSuspend;
}

export interface RuntimeCronResult {
  processed: number;
  suspended: string[];
  errors: string[];
}

/**
 * Daily runtime deduction cron.
 *
 * For each tenant with a positive balance:
 * 1. Look up active bot count
 * 2. Debit (bots * DAILY_BOT_COST_CENTS) from their balance
 * 3. If balance is insufficient, debit what's available and trigger suspension
 */
export async function runRuntimeDeductions(cfg: RuntimeCronConfig): Promise<RuntimeCronResult> {
  const result: RuntimeCronResult = {
    processed: 0,
    suspended: [],
    errors: [],
  };

  const tenants = cfg.ledger.tenantsWithBalance();

  for (const { tenantId, balanceCents } of tenants) {
    try {
      const botCount = await cfg.getActiveBotCount(tenantId);
      if (botCount <= 0) continue;

      const totalCost = botCount * DAILY_BOT_COST_CENTS;

      if (balanceCents >= totalCost) {
        // Full deduction
        cfg.ledger.debit(
          tenantId,
          totalCost,
          "bot_runtime",
          `Daily runtime: ${botCount} bot(s) x $${(DAILY_BOT_COST_CENTS / 100).toFixed(2)}`,
        );
      } else {
        // Partial deduction — debit remaining balance, then suspend
        if (balanceCents > 0) {
          cfg.ledger.debit(
            tenantId,
            balanceCents,
            "bot_runtime",
            `Partial daily runtime (balance exhausted): ${botCount} bot(s)`,
          );
        }

        result.suspended.push(tenantId);
        if (cfg.onSuspend) {
          await cfg.onSuspend(tenantId);
        }
      }

      result.processed++;
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        result.suspended.push(tenantId);
        if (cfg.onSuspend) {
          await cfg.onSuspend(tenantId);
        }
        result.processed++;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Runtime deduction failed", { tenantId, error: msg });
        result.errors.push(`${tenantId}: ${msg}`);
      }
    }
  }

  return result;
}
