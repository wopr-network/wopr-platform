import { logger } from "../../config/logger.js";
import type { IBotInstanceRepository } from "../../fleet/bot-instance-repository.js";
import { RESOURCE_TIERS } from "../../fleet/resource-tiers.js";
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

/** Low balance threshold in cents (20% of signup grant = $1.00). */
export const LOW_BALANCE_THRESHOLD_CENTS = 100;

export interface RuntimeCronConfig {
  ledger: CreditLedger;
  getActiveBotCount: GetActiveBotCount;
  onSuspend?: OnSuspend;
  /** Called when balance drops below LOW_BALANCE_THRESHOLD_CENTS ($1.00). */
  onLowBalance?: (tenantId: string, balanceCents: number) => void | Promise<void>;
  /** Called when balance hits exactly 0 or goes negative. */
  onCreditsExhausted?: (tenantId: string) => void | Promise<void>;
  /**
   * Optional: returns total daily resource tier surcharge in cents for a tenant.
   * Sum of all active bots' tier surcharges. If not provided, no surcharge is applied.
   */
  getResourceTierCosts?: (tenantId: string) => number | Promise<number>;
  /**
   * Optional: returns total daily storage tier surcharge in cents for a tenant.
   * Sum of all active bots' storage tier costs. If not provided, no surcharge applied.
   */
  getStorageTierCosts?: (tenantId: string) => number | Promise<number>;
}

export interface RuntimeCronResult {
  processed: number;
  suspended: string[];
  errors: string[];
}

/**
 * Build a `getResourceTierCosts` callback suitable for passing to `runRuntimeDeductions`.
 *
 * Sums the daily surcharge of all active bots owned by a tenant by reading each
 * bot's resource tier from `IBotInstanceRepository` and looking up the cost in
 * `RESOURCE_TIERS`. Standard-tier bots contribute 0 cents.
 */
export function buildResourceTierCosts(
  botInstanceRepo: IBotInstanceRepository,
  getBotBillingActiveIds: (tenantId: string) => string[],
): (tenantId: string) => number {
  return (tenantId: string): number => {
    const botIds = getBotBillingActiveIds(tenantId);
    let total = 0;
    for (const botId of botIds) {
      const tier = botInstanceRepo.getResourceTier(botId) ?? "standard";
      const tierKey = tier in RESOURCE_TIERS ? (tier as keyof typeof RESOURCE_TIERS) : "standard";
      total += RESOURCE_TIERS[tierKey].dailyCostCents;
    }
    return total;
  };
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

        // Debit resource tier surcharges (if any)
        if (cfg.getResourceTierCosts) {
          const tierCost = await cfg.getResourceTierCosts(tenantId);
          if (tierCost > 0) {
            const balanceAfterRuntime = cfg.ledger.balance(tenantId);
            if (balanceAfterRuntime >= tierCost) {
              cfg.ledger.debit(tenantId, tierCost, "resource_upgrade", "Daily resource tier surcharge");
            } else if (balanceAfterRuntime > 0) {
              cfg.ledger.debit(
                tenantId,
                balanceAfterRuntime,
                "resource_upgrade",
                "Partial resource tier surcharge (balance exhausted)",
              );
            }
          }
        }

        const newBalance = cfg.ledger.balance(tenantId);

        // Fire onLowBalance if balance crossed below threshold from above
        if (
          newBalance > 0 &&
          newBalance <= LOW_BALANCE_THRESHOLD_CENTS &&
          balanceCents > LOW_BALANCE_THRESHOLD_CENTS &&
          cfg.onLowBalance
        ) {
          await cfg.onLowBalance(tenantId, newBalance);
        }

        // Fire onCreditsExhausted if balance just hit 0
        if (newBalance <= 0 && balanceCents > 0 && cfg.onCreditsExhausted) {
          await cfg.onCreditsExhausted(tenantId);
        }

        // Debit storage tier surcharges (if any)
        if (cfg.getStorageTierCosts) {
          const storageCost = await cfg.getStorageTierCosts(tenantId);
          if (storageCost > 0) {
            const currentBalance = cfg.ledger.balance(tenantId);
            if (currentBalance >= storageCost) {
              cfg.ledger.debit(tenantId, storageCost, "storage_upgrade", "Daily storage tier surcharge");
            } else {
              // Partial debit — take what's left, then suspend
              if (currentBalance > 0) {
                cfg.ledger.debit(
                  tenantId,
                  currentBalance,
                  "storage_upgrade",
                  "Partial storage tier surcharge (balance exhausted)",
                );
              }
              result.suspended.push(tenantId);
              if (cfg.onSuspend) await cfg.onSuspend(tenantId);
            }
          }
        }
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

        if (cfg.onCreditsExhausted) {
          await cfg.onCreditsExhausted(tenantId);
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
