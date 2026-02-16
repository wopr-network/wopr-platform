import { logger } from "../../config/logger.js";
import type { CreditRepository } from "../../domain/repositories/credit-repository.js";
import { InsufficientBalanceError } from "../../domain/repositories/credit-repository.js";
import { Money } from "../../domain/value-objects/money.js";

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
  ledger: CreditRepository;
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

  const tenants = await cfg.ledger.getTenantsWithPositiveBalance();

  for (const { tenantId, balance } of tenants) {
    try {
      const botCount = await cfg.getActiveBotCount(tenantId.toString());
      if (botCount <= 0) continue;

      const totalCost = Money.fromCents(botCount * DAILY_BOT_COST_CENTS);

      if (balance.toCents() >= totalCost.toCents()) {
        await cfg.ledger.debit(
          tenantId,
          totalCost,
          "bot_runtime",
          `Daily runtime: ${botCount} bot(s) x $${(DAILY_BOT_COST_CENTS / 100).toFixed(2)}`,
        );
      } else {
        if (balance.toCents() > 0) {
          await cfg.ledger.debit(
            tenantId,
            balance,
            "bot_runtime",
            `Partial daily runtime (balance exhausted): ${botCount} bot(s)`,
          );
        }

        result.suspended.push(tenantId.toString());
        if (cfg.onSuspend) {
          await cfg.onSuspend(tenantId.toString());
        }
      }

      result.processed++;
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        result.suspended.push(tenantId.toString());
        if (cfg.onSuspend) {
          await cfg.onSuspend(tenantId.toString());
        }
        result.processed++;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Runtime deduction failed", { tenantId: tenantId.toString(), error: msg });
        result.errors.push(`${tenantId.toString()}: ${msg}`);
      }
    }
  }

  return result;
}
