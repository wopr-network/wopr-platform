import { and, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { botInstances } from "../../db/schema/bot-instances.js";
import { STORAGE_TIERS, type StorageTierKey } from "../../fleet/storage-tiers.js";
import type { ICreditLedger } from "./credit-ledger.js";

/** Billing state literals */
export type BillingState = "active" | "suspended" | "destroyed";

/** Number of days before a suspended bot is destroyed. */
export const SUSPENSION_GRACE_DAYS = 30;

export interface IBotBilling {
  getActiveBotCount(tenantId: string): number;
  suspendBot(botId: string): void;
  suspendAllForTenant(tenantId: string): string[];
  reactivateBot(botId: string): void;
  checkReactivation(tenantId: string, ledger: ICreditLedger): string[];
  destroyBot(botId: string): void;
  destroyExpiredBots(): string[];
  getBotBilling(botId: string): unknown;
  listForTenant(tenantId: string): unknown[];
  registerBot(botId: string, tenantId: string, name: string): void;
  getStorageTier(botId: string): string | null;
  setStorageTier(botId: string, tier: string): void;
  getStorageTierCostsForTenant(tenantId: string): number;
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
  getActiveBotCount(tenantId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")))
      .get();

    return row?.count ?? 0;
  }

  /**
   * Suspend a bot: stop billing, set destroy timer.
   * Sets billingState='suspended', suspendedAt=now, destroyAfter=now+30 days.
   */
  suspendBot(botId: string): void {
    this.db
      .update(botInstances)
      .set({
        billingState: "suspended",
        suspendedAt: sql`(datetime('now'))`,
        destroyAfter: sql`(datetime('now', '+${sql.raw(String(SUSPENSION_GRACE_DAYS))} days'))`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(botInstances.id, botId))
      .run();
  }

  /**
   * Suspend ALL active bots for a tenant.
   * Returns the IDs of suspended bots.
   */
  suspendAllForTenant(tenantId: string): string[] {
    const activeBots = this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")))
      .all();

    for (const bot of activeBots) {
      this.suspendBot(bot.id);
    }

    return activeBots.map((b) => b.id);
  }

  /**
   * Reactivate a suspended bot: clear suspension, resume billing.
   * Sets billingState='active', clears suspendedAt and destroyAfter.
   */
  reactivateBot(botId: string): void {
    this.db
      .update(botInstances)
      .set({
        billingState: "active",
        suspendedAt: null,
        destroyAfter: null,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(eq(botInstances.id, botId), eq(botInstances.billingState, "suspended")))
      .run();
  }

  /**
   * Check if a tenant has suspended bots and reactivate them if balance > 0.
   * Called after credit purchase (Stripe webhook).
   *
   * @returns IDs of reactivated bots.
   */
  checkReactivation(tenantId: string, ledger: ICreditLedger): string[] {
    const balance = ledger.balance(tenantId);
    if (balance <= 0) return [];

    const suspended = this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "suspended")))
      .all();

    for (const bot of suspended) {
      this.reactivateBot(bot.id);
    }

    return suspended.map((b) => b.id);
  }

  /**
   * Mark a bot as destroyed.
   * Sets billingState='destroyed'. Actual Docker cleanup is handled by the caller.
   */
  destroyBot(botId: string): void {
    this.db
      .update(botInstances)
      .set({
        billingState: "destroyed",
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(botInstances.id, botId))
      .run();
  }

  /**
   * Find and mark as destroyed all bots whose suspension grace period has expired.
   * Returns IDs of destroyed bots (caller handles Docker rm).
   */
  destroyExpiredBots(): string[] {
    const expired = this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.billingState, "suspended"), lte(botInstances.destroyAfter, sql`(datetime('now'))`)))
      .all();

    for (const bot of expired) {
      this.destroyBot(bot.id);
    }

    return expired.map((b) => b.id);
  }

  /** Get billing info for a single bot. */
  getBotBilling(botId: string) {
    return this.db.select().from(botInstances).where(eq(botInstances.id, botId)).get();
  }

  /** List all bots for a tenant (any billing state). */
  listForTenant(tenantId: string) {
    return this.db.select().from(botInstances).where(eq(botInstances.tenantId, tenantId)).all();
  }

  /** Get storage tier key for a bot. Returns null if bot doesn't exist. */
  getStorageTier(botId: string): string | null {
    const row = this.db
      .select({ storageTier: botInstances.storageTier })
      .from(botInstances)
      .where(eq(botInstances.id, botId))
      .get();
    return row?.storageTier ?? null;
  }

  /** Set storage tier for a bot. */
  setStorageTier(botId: string, tier: string): void {
    this.db
      .update(botInstances)
      .set({
        storageTier: tier,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(botInstances.id, botId))
      .run();
  }

  /** Sum daily storage tier costs for all active bots for a tenant. */
  getStorageTierCostsForTenant(tenantId: string): number {
    const activeBots = this.db
      .select({ storageTier: botInstances.storageTier })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")))
      .all();

    let total = 0;
    for (const bot of activeBots) {
      const tier = bot.storageTier as StorageTierKey;
      total += STORAGE_TIERS[tier]?.dailyCostCents ?? 0;
    }
    return total;
  }

  /** Register a new bot instance for billing. */
  registerBot(botId: string, tenantId: string, name: string): void {
    this.db
      .insert(botInstances)
      .values({
        id: botId,
        tenantId,
        name,
        billingState: "active",
      })
      .run();
  }
}

// Backward-compat alias.
export { DrizzleBotBilling as BotBilling };
