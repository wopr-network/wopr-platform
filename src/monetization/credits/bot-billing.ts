import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { botInstances } from "../../db/schema/bot-instances.js";
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
  constructor(private readonly db: DrizzleDb) {}

  /** Count active bots for a tenant (used by runtime cron). */
  async getActiveBotCount(tenantId: string): Promise<number> {
    const row = (
      await this.db
        .select({ count: sql<number>`count(*)` })
        .from(botInstances)
        .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")))
    )[0];

    return row?.count ?? 0;
  }

  /**
   * Suspend a bot: stop billing, set destroy timer.
   * Sets billingState='suspended', suspendedAt=now, destroyAfter=now+30 days.
   */
  async suspendBot(botId: string): Promise<void> {
    await this.db
      .update(botInstances)
      .set({
        billingState: "suspended",
        suspendedAt: sql`now()`,
        destroyAfter: sql`now() + interval '${sql.raw(String(SUSPENSION_GRACE_DAYS))} days'`,
        updatedAt: sql`now()`,
      })
      .where(eq(botInstances.id, botId));
  }

  /**
   * Suspend ALL active bots for a tenant.
   * Returns the IDs of suspended bots.
   */
  async suspendAllForTenant(tenantId: string): Promise<string[]> {
    const activeBots = await this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")));

    for (const bot of activeBots) {
      await this.suspendBot(bot.id);
    }

    return activeBots.map((b) => b.id);
  }

  /**
   * Reactivate a suspended bot: clear suspension, resume billing.
   * Sets billingState='active', clears suspendedAt and destroyAfter.
   */
  async reactivateBot(botId: string): Promise<void> {
    await this.db
      .update(botInstances)
      .set({
        billingState: "active",
        suspendedAt: null,
        destroyAfter: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(botInstances.id, botId), eq(botInstances.billingState, "suspended")));
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

    const suspended = await this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "suspended")));

    for (const bot of suspended) {
      await this.reactivateBot(bot.id);
    }

    return suspended.map((b) => b.id);
  }

  /**
   * Mark a bot as destroyed.
   * Sets billingState='destroyed'. Actual Docker cleanup is handled by the caller.
   */
  async destroyBot(botId: string): Promise<void> {
    await this.db
      .update(botInstances)
      .set({
        billingState: "destroyed",
        updatedAt: sql`now()`,
      })
      .where(eq(botInstances.id, botId));
  }

  /**
   * Find and mark as destroyed all bots whose suspension grace period has expired.
   * Returns IDs of destroyed bots (caller handles Docker rm).
   */
  async destroyExpiredBots(): Promise<string[]> {
    const expired = await this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.billingState, "suspended"), sql`${botInstances.destroyAfter}::timestamp <= now()`));

    for (const bot of expired) {
      await this.destroyBot(bot.id);
    }

    return expired.map((b) => b.id);
  }

  /** Get billing info for a single bot. */
  async getBotBilling(botId: string): Promise<unknown> {
    return (await this.db.select().from(botInstances).where(eq(botInstances.id, botId)))[0];
  }

  /** List all bots for a tenant (any billing state). */
  async listForTenant(tenantId: string): Promise<unknown[]> {
    return this.db.select().from(botInstances).where(eq(botInstances.tenantId, tenantId));
  }

  /** Get storage tier key for a bot. Returns null if bot doesn't exist. */
  async getStorageTier(botId: string): Promise<string | null> {
    const row = (
      await this.db
        .select({ storageTier: botInstances.storageTier })
        .from(botInstances)
        .where(eq(botInstances.id, botId))
    )[0];
    return row?.storageTier ?? null;
  }

  /** Set storage tier for a bot. */
  async setStorageTier(botId: string, tier: string): Promise<void> {
    await this.db
      .update(botInstances)
      .set({
        storageTier: tier,
        updatedAt: sql`now()`,
      })
      .where(eq(botInstances.id, botId));
  }

  /** Sum daily storage tier costs for all active bots for a tenant. */
  async getStorageTierCostsForTenant(tenantId: string): Promise<Credit> {
    const activeBots = await this.db
      .select({ storageTier: botInstances.storageTier })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")));

    let total = Credit.ZERO;
    for (const bot of activeBots) {
      const tier = bot.storageTier as StorageTierKey;
      total = total.add(STORAGE_TIERS[tier]?.dailyCost ?? Credit.ZERO);
    }
    return total;
  }

  /** Register a new bot instance for billing. */
  async registerBot(botId: string, tenantId: string, name: string): Promise<void> {
    await this.db.insert(botInstances).values({
      id: botId,
      tenantId,
      name,
      billingState: "active",
    });
  }
}

// Backward-compat alias.
export { DrizzleBotBilling as BotBilling };
