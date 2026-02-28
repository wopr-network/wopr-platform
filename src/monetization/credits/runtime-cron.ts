import { logger } from "../../config/logger.js";
import type { IBotInstanceRepository } from "../../fleet/bot-instance-repository.js";
import { RESOURCE_TIERS } from "../../fleet/resource-tiers.js";
import { Credit } from "../credit.js";
import type { CreditLedger } from "./credit-ledger.js";
import { InsufficientBalanceError } from "./credit-ledger.js";

/**
 * Bot runtime cost: $5/bot/month prorated daily.
 * $5.00 / 30 ≈ $0.1667/day, rounded to $0.17.
 */
export const DAILY_BOT_COST = Credit.fromCents(17);

/** Callback invoked when a tenant's balance hits zero during deduction. */
export type OnSuspend = (tenantId: string) => void | Promise<void>;

/** Resolve the number of active bots for a given tenant. */
export type GetActiveBotCount = (tenantId: string) => number | Promise<number>;

/** Low balance threshold ($1.00 = 20% of signup grant). */
export const LOW_BALANCE_THRESHOLD = Credit.fromCents(100);

export interface RuntimeCronConfig {
  ledger: CreditLedger;
  getActiveBotCount: GetActiveBotCount;
  /** The date being billed, as YYYY-MM-DD. Used for idempotency. */
  date: string;
  onSuspend?: OnSuspend;
  /** Called when balance drops below LOW_BALANCE_THRESHOLD ($1.00). */
  onLowBalance?: (tenantId: string, balance: Credit) => void | Promise<void>;
  /** Called when balance hits exactly 0 or goes negative. */
  onCreditsExhausted?: (tenantId: string) => void | Promise<void>;
  /**
   * Optional: returns total daily resource tier surcharge for a tenant.
   * Sum of all active bots' tier surcharges. If not provided, no surcharge is applied.
   */
  getResourceTierCosts?: (tenantId: string) => Credit | Promise<Credit>;
  /**
   * Optional: returns total daily storage tier surcharge for a tenant.
   * Sum of all active bots' storage tier costs. If not provided, no surcharge applied.
   */
  getStorageTierCosts?: (tenantId: string) => Credit | Promise<Credit>;
}

export interface RuntimeCronResult {
  processed: number;
  suspended: string[];
  errors: string[];
  /** Tenant IDs skipped because they were already billed for this date. */
  skipped: string[];
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
  getBotBillingActiveIds: (tenantId: string) => Promise<string[]>,
): (tenantId: string) => Promise<Credit> {
  return async (tenantId: string): Promise<Credit> => {
    const botIds = await getBotBillingActiveIds(tenantId);
    let total = Credit.ZERO;
    for (const botId of botIds) {
      const tier = (await botInstanceRepo.getResourceTier(botId)) ?? "standard";
      const tierKey = tier in RESOURCE_TIERS ? (tier as keyof typeof RESOURCE_TIERS) : "standard";
      total = total.add(RESOURCE_TIERS[tierKey].dailyCost);
    }
    return total;
  };
}

/**
 * Returns true when `err` is a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used to detect a concurrent cron run that already inserted the same referenceId.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "23505") return true;
  const msg = err.message;
  return msg.includes("UNIQUE") || msg.includes("duplicate key");
}

/**
 * Daily runtime deduction cron.
 *
 * For each tenant with a positive balance:
 * 1. Look up active bot count
 * 2. Debit (bots * DAILY_BOT_COST) from their balance
 * 3. If balance is insufficient, debit what's available and trigger suspension
 */
export async function runRuntimeDeductions(cfg: RuntimeCronConfig): Promise<RuntimeCronResult> {
  const result: RuntimeCronResult = {
    processed: 0,
    suspended: [],
    errors: [],
    skipped: [],
  };

  const tenants = await cfg.ledger.tenantsWithBalance();

  for (const { tenantId, balance } of tenants) {
    try {
      const runtimeRef = `runtime:${cfg.date}:${tenantId}`;
      if (await cfg.ledger.hasReferenceId(runtimeRef)) {
        result.skipped.push(tenantId);
        continue;
      }

      const botCount = await cfg.getActiveBotCount(tenantId);
      if (botCount <= 0) continue;

      const totalCost = DAILY_BOT_COST.multiply(botCount);

      if (!balance.lessThan(totalCost)) {
        // Full deduction
        await cfg.ledger.debit(
          tenantId,
          totalCost,
          "bot_runtime",
          `Daily runtime: ${botCount} bot(s) x $${DAILY_BOT_COST.toDollars().toFixed(2)}`,
          runtimeRef,
        );

        // Debit resource tier surcharges (if any)
        if (cfg.getResourceTierCosts) {
          const tierCost = await cfg.getResourceTierCosts(tenantId);
          if (!tierCost.isZero()) {
            const balanceAfterRuntime = await cfg.ledger.balance(tenantId);
            if (!balanceAfterRuntime.lessThan(tierCost)) {
              await cfg.ledger.debit(
                tenantId,
                tierCost,
                "resource_upgrade",
                "Daily resource tier surcharge",
                `runtime-tier:${cfg.date}:${tenantId}`,
              );
            } else if (balanceAfterRuntime.greaterThan(Credit.ZERO)) {
              await cfg.ledger.debit(
                tenantId,
                balanceAfterRuntime,
                "resource_upgrade",
                "Partial resource tier surcharge (balance exhausted)",
                `runtime-tier:${cfg.date}:${tenantId}`,
              );
            }
          }
        }

        const newBalance = await cfg.ledger.balance(tenantId);

        // Fire onLowBalance if balance crossed below threshold from above
        if (
          newBalance.greaterThan(Credit.ZERO) &&
          !newBalance.greaterThan(LOW_BALANCE_THRESHOLD) &&
          balance.greaterThan(LOW_BALANCE_THRESHOLD) &&
          cfg.onLowBalance
        ) {
          await cfg.onLowBalance(tenantId, newBalance);
        }

        // Fire onCreditsExhausted if balance just hit 0
        if (!newBalance.greaterThan(Credit.ZERO) && balance.greaterThan(Credit.ZERO) && cfg.onCreditsExhausted) {
          await cfg.onCreditsExhausted(tenantId);
        }

        // Debit storage tier surcharges (if any)
        if (cfg.getStorageTierCosts) {
          const storageCost = await cfg.getStorageTierCosts(tenantId);
          if (!storageCost.isZero()) {
            const currentBalance = await cfg.ledger.balance(tenantId);
            if (!currentBalance.lessThan(storageCost)) {
              await cfg.ledger.debit(
                tenantId,
                storageCost,
                "storage_upgrade",
                "Daily storage tier surcharge",
                `runtime-storage:${cfg.date}:${tenantId}`,
              );
            } else {
              // Partial debit — take what's left, then suspend
              if (currentBalance.greaterThan(Credit.ZERO)) {
                await cfg.ledger.debit(
                  tenantId,
                  currentBalance,
                  "storage_upgrade",
                  "Partial storage tier surcharge (balance exhausted)",
                  `runtime-storage:${cfg.date}:${tenantId}`,
                );
              }
              result.suspended.push(tenantId);
              if (cfg.onSuspend) await cfg.onSuspend(tenantId);
            }
          }
        }
      } else {
        // Partial deduction — debit remaining balance, then suspend
        if (balance.greaterThan(Credit.ZERO)) {
          await cfg.ledger.debit(
            tenantId,
            balance,
            "bot_runtime",
            `Partial daily runtime (balance exhausted): ${botCount} bot(s)`,
            runtimeRef,
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
      } else if (isUniqueConstraintViolation(err)) {
        // Concurrent cron run already committed this referenceId — treat as already billed.
        result.skipped.push(tenantId);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Runtime deduction failed", { tenantId, error: msg });
        result.errors.push(`${tenantId}: ${msg}`);
      }
    }
  }

  return result;
}
