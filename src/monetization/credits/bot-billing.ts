import { logger } from "../../config/logger.js";
import type { IBotInstanceRepository } from "../../fleet/bot-instance-repository.js";
import type { INodeCommandBus } from "../../fleet/node-command-bus.js";
import { STORAGE_TIERS, type StorageTierKey } from "../../fleet/storage-tiers.js";
import { Credit } from "../credit.js";
import type { ICreditLedger } from "./credit-ledger.js";

/** Billing state literals */
export type BillingState = "active" | "suspended" | "destroyed";

/** Number of days before a suspended bot is destroyed. */
export const SUSPENSION_GRACE_DAYS = 30;

export interface IBotBilling {
  getActiveBotCount(tenantId: string): Promise<number>;
  suspendBot(botId: string): Promise<void>;
  suspendAllForTenant(tenantId: string): Promise<string[]>;
  reactivateBot(botId: string): Promise<void>;
  checkReactivation(tenantId: string, ledger: ICreditLedger): Promise<string[]>;
  destroyBot(botId: string): Promise<void>;
  destroyExpiredBots(): Promise<string[]>;
  getBotBilling(botId: string): Promise<unknown>;
  listForTenant(tenantId: string): Promise<unknown[]>;
  registerBot(botId: string, tenantId: string, name: string): Promise<void>;
  getStorageTier(botId: string): Promise<string | null>;
  setStorageTier(botId: string, tier: string): Promise<void>;
  getStorageTierCostsForTenant(tenantId: string): Promise<Credit>;
}

/**
 * Bot billing lifecycle manager.
 *
 * Handles suspend/reactivate/destroy transitions and provides
 * active-bot-count queries for the daily runtime cron.
 */
export class DrizzleBotBilling implements IBotBilling {
  constructor(
    private readonly botInstanceRepo: IBotInstanceRepository,
    private readonly commandBus?: INodeCommandBus | null,
  ) {}

  /** Send a command to the bot's node. Logs but never throws on failure. */
  private async sendCommand(botId: string, type: string): Promise<void> {
    if (!this.commandBus) return;
    try {
      const bot = await this.botInstanceRepo.getById(botId);
      if (!bot?.nodeId) return;
      await this.commandBus.send(bot.nodeId, {
        type,
        payload: { name: bot.name },
      });
    } catch (err) {
      logger.error(`[BotBilling] Failed to send ${type} for bot ${botId}:`, err);
    }
  }

  /** Count active bots for a tenant (used by runtime cron). */
  async getActiveBotCount(tenantId: string): Promise<number> {
    return this.botInstanceRepo.countActiveByTenant(tenantId);
  }

  /**
   * Suspend a bot: stop billing, set destroy timer.
   * Sets billingState='suspended', suspendedAt=now, destroyAfter=now+30 days.
   */
  async suspendBot(botId: string): Promise<void> {
    await this.botInstanceRepo.suspend(botId, SUSPENSION_GRACE_DAYS);
    await this.sendCommand(botId, "bot.stop");
  }

  /**
   * Suspend ALL active bots for a tenant.
   * Returns the IDs of suspended bots.
   */
  async suspendAllForTenant(tenantId: string): Promise<string[]> {
    const ids = await this.botInstanceRepo.listActiveIdsByTenant(tenantId);
    for (const id of ids) {
      await this.suspendBot(id);
    }
    return ids;
  }

  /**
   * Reactivate a suspended bot: clear suspension, resume billing.
   * Sets billingState='active', clears suspendedAt and destroyAfter.
   */
  async reactivateBot(botId: string): Promise<void> {
    await this.botInstanceRepo.reactivate(botId);
    await this.sendCommand(botId, "bot.start");
  }

  /**
   * Check if a tenant has suspended bots and reactivate them if balance > 0.
   * Called after credit purchase (Stripe webhook).
   *
   * @returns IDs of reactivated bots.
   */
  async checkReactivation(tenantId: string, ledger: ICreditLedger): Promise<string[]> {
    const balance = await ledger.balance(tenantId);
    if (balance.isNegative() || balance.isZero()) return [];

    const ids = await this.botInstanceRepo.listSuspendedIdsByTenant(tenantId);
    for (const id of ids) {
      await this.reactivateBot(id);
    }
    return ids;
  }

  /**
   * Mark a bot as destroyed.
   * Sets billingState='destroyed'. Actual Docker cleanup is handled by the caller.
   */
  async destroyBot(botId: string): Promise<void> {
    await this.botInstanceRepo.markDestroyed(botId);
  }

  /**
   * Find and mark as destroyed all bots whose suspension grace period has expired.
   * Returns IDs of destroyed bots (caller handles Docker rm).
   */
  async destroyExpiredBots(): Promise<string[]> {
    const ids = await this.botInstanceRepo.listExpiredSuspendedIds();
    for (const id of ids) {
      await this.destroyBot(id);
    }
    return ids;
  }

  /** Get billing info for a single bot. */
  async getBotBilling(botId: string): Promise<unknown> {
    return this.botInstanceRepo.getById(botId);
  }

  /** List all bots for a tenant (any billing state). */
  async listForTenant(tenantId: string): Promise<unknown[]> {
    return this.botInstanceRepo.listByTenant(tenantId);
  }

  /** Get storage tier key for a bot. Returns null if bot doesn't exist. */
  async getStorageTier(botId: string): Promise<string | null> {
    return this.botInstanceRepo.getStorageTier(botId);
  }

  /** Set storage tier for a bot. */
  async setStorageTier(botId: string, tier: string): Promise<void> {
    await this.botInstanceRepo.setStorageTier(botId, tier);
  }

  /** Sum daily storage tier costs for all active bots for a tenant. */
  async getStorageTierCostsForTenant(tenantId: string): Promise<Credit> {
    const tiers = await this.botInstanceRepo.listActiveStorageTiers(tenantId);
    let total = Credit.ZERO;
    for (const t of tiers) {
      total = total.add(STORAGE_TIERS[t as StorageTierKey]?.dailyCost ?? Credit.ZERO);
    }
    return total;
  }

  /** Register a new bot instance for billing. */
  async registerBot(botId: string, tenantId: string, name: string): Promise<void> {
    await this.botInstanceRepo.register(botId, tenantId, name);
  }
}

// Backward-compat alias.
export { DrizzleBotBilling as BotBilling };
