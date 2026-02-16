import { and, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { botInstances } from "../../db/schema/bot-instances.js";
import type { CreditRepository } from "../../domain/repositories/credit-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";

/** Billing state literals */
export type BillingState = "active" | "suspended" | "destroyed";

/** Number of days before a suspended bot is destroyed. */
export const SUSPENSION_GRACE_DAYS = 30;

/**
 * Bot billing lifecycle manager.
 *
 * Handles suspend/reactivate/destroy transitions and provides
 * active-bot-count queries for the daily runtime cron.
 */
export class BotBilling {
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
   * Used when balance hits zero or tenant is delinquent.
   * Returns list of suspended bot IDs.
   */
  suspendAllForTenant(tenantId: string): string[] {
    const active = this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")))
      .all();

    for (const bot of active) {
      this.suspendBot(bot.id);
    }

    return active.map((b) => b.id);
  }

  /**
   * Reactivate a suspended bot.
   * Clears suspendedAt and destroyAfter, sets billingState='active'.
   * Only reactivates bots that are currently suspended (not destroyed).
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
   * Check if suspended bots should be reactivated (balance is positive).
   * Reactivates all suspended bots for a tenant if balance > 0.
   * Returns list of reactivated bot IDs.
   * 
   * MIGRATED: Now uses CreditRepository instead of CreditLedger
   */
  async checkReactivation(tenantId: string, repository: CreditRepository): Promise<string[]> {
    const balance = await repository.getBalance(TenantId.create(tenantId));
    
    if (balance.balance.toCents() === 0) {
      return [];
    }

    const suspended = this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(
        and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "suspended"))
      )
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
