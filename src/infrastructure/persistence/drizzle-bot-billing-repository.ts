/**
 * Drizzle Implementation: BotBillingRepository (ASYNC API)
 * 
 * better-sqlite3 is synchronous, but we expose async API.
 * This allows swapping to PostgreSQL or other async databases later.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/index.js';
import { botInstances } from '../../db/schema/bot-instances.js';
import type { BotBillingRepository } from '../../domain/repositories/bot-billing-repository.js';
import { TenantId } from '../../domain/value-objects/tenant-id.js';
import { BotInstance, type BillingState } from '../../domain/entities/bot-instance.js';

const SUSPENSION_GRACE_DAYS = 30;

function rowToBotInstance(row: typeof botInstances.$inferSelect): BotInstance {
  return new BotInstance({
    id: row.id,
    tenantId: TenantId.create(row.tenantId),
    name: row.name,
    nodeId: row.nodeId,
    billingState: row.billingState as BillingState,
    suspendedAt: row.suspendedAt ? new Date(row.suspendedAt) : null,
    destroyAfter: row.destroyAfter ? new Date(row.destroyAfter) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
}

export class DrizzleBotBillingRepository implements BotBillingRepository {
  constructor(private readonly db: DrizzleDb) {}

  async registerBot(botId: string, tenantId: TenantId, name: string): Promise<void> {
    this.db
      .insert(botInstances)
      .values({
        id: botId,
        tenantId: tenantId.toString(),
        name,
        billingState: 'active',
      })
      .run();
  }

  async getBotBilling(botId: string): Promise<BotInstance | null> {
    const row = this.db
      .select()
      .from(botInstances)
      .where(eq(botInstances.id, botId))
      .get();

    return row ? rowToBotInstance(row) : null;
  }

  async getActiveBotCount(tenantId: TenantId): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(botInstances)
      .where(
        and(
          eq(botInstances.tenantId, tenantId.toString()),
          eq(botInstances.billingState, 'active')
        )
      )
      .get();

    return row?.count ?? 0;
  }

  async listForTenant(tenantId: TenantId): Promise<BotInstance[]> {
    const rows = this.db
      .select()
      .from(botInstances)
      .where(eq(botInstances.tenantId, tenantId.toString()))
      .all();

    return rows.map(rowToBotInstance);
  }

  async suspendBot(botId: string): Promise<void> {
    this.db
      .update(botInstances)
      .set({
        billingState: 'suspended',
        suspendedAt: sql`(datetime('now'))`,
        destroyAfter: sql`(datetime('now', '+${sql.raw(String(SUSPENSION_GRACE_DAYS))} days'))`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(botInstances.id, botId))
      .run();
  }

  async suspendAllForTenant(tenantId: TenantId): Promise<string[]> {
    const active = this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(
        and(
          eq(botInstances.tenantId, tenantId.toString()),
          eq(botInstances.billingState, 'active')
        )
      )
      .all();

    for (const bot of active) {
      await this.suspendBot(bot.id);
    }

    return active.map((b) => b.id);
  }

  async reactivateBot(botId: string): Promise<void> {
    this.db
      .update(botInstances)
      .set({
        billingState: 'active',
        suspendedAt: null,
        destroyAfter: null,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(and(eq(botInstances.id, botId), eq(botInstances.billingState, 'suspended')))
      .run();
  }

  async getSuspendedBots(tenantId: TenantId): Promise<BotInstance[]> {
    const rows = this.db
      .select()
      .from(botInstances)
      .where(
        and(
          eq(botInstances.tenantId, tenantId.toString()),
          eq(botInstances.billingState, 'suspended')
        )
      )
      .all();

    return rows.map(rowToBotInstance);
  }

  async destroyBot(botId: string): Promise<void> {
    this.db
      .update(botInstances)
      .set({
        billingState: 'destroyed',
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(botInstances.id, botId))
      .run();
  }

  async destroyExpiredBots(): Promise<string[]> {
    const expired = this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(
        and(
          eq(botInstances.billingState, 'suspended'),
          lte(botInstances.destroyAfter, sql`(datetime('now'))`)
        )
      )
      .all();

    for (const bot of expired) {
      await this.destroyBot(bot.id);
    }

    return expired.map((b) => b.id);
  }

  async assignToNode(botId: string, nodeId: string): Promise<void> {
    this.db
      .update(botInstances)
      .set({
        nodeId,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(botInstances.id, botId))
      .run();
  }
}
