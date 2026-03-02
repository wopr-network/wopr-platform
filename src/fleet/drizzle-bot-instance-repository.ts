import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { botInstances, tenantCustomers } from "../db/schema/index.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { BillingState, BotInstance, NewBotInstance, TenantWithTier } from "./repository-types.js";

/** Drizzle-backed implementation of IBotInstanceRepository. */
export class DrizzleBotInstanceRepository implements IBotInstanceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getById(id: string): Promise<BotInstance | null> {
    const rows = await this.db.select().from(botInstances).where(eq(botInstances.id, id));
    return rows[0] ? toInstance(rows[0]) : null;
  }

  async listByNode(nodeId: string): Promise<BotInstance[]> {
    const rows = await this.db.select().from(botInstances).where(eq(botInstances.nodeId, nodeId));
    return rows.map(toInstance);
  }

  async listByTenant(tenantId: string): Promise<BotInstance[]> {
    const rows = await this.db.select().from(botInstances).where(eq(botInstances.tenantId, tenantId));
    return rows.map(toInstance);
  }

  async create(data: NewBotInstance): Promise<BotInstance> {
    const now = new Date().toISOString();
    await this.db.insert(botInstances).values({
      id: data.id,
      tenantId: data.tenantId,
      name: data.name,
      nodeId: data.nodeId,
      billingState: data.billingState ?? "active",
      createdAt: now,
      updatedAt: now,
      createdByUserId: data.createdByUserId ?? null,
    });
    const created = await this.getById(data.id);
    if (!created) throw new Error(`Bot instance not found after insert: ${data.id}`);
    return created;
  }

  async reassign(id: string, nodeId: string): Promise<BotInstance> {
    const now = new Date().toISOString();
    const result = await this.db
      .update(botInstances)
      .set({ nodeId, updatedAt: now })
      .where(eq(botInstances.id, id))
      .returning({ id: botInstances.id });
    if (result.length === 0) {
      throw new Error(`Bot instance not found: ${id}`);
    }
    const updated = await this.getById(id);
    if (!updated) throw new Error(`Bot instance not found after update: ${id}`);
    return updated;
  }

  async setBillingState(id: string, state: BillingState): Promise<BotInstance> {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      billingState: state,
      updatedAt: now,
    };

    if (state === "suspended") {
      updates.suspendedAt = now;
      const destroyDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      updates.destroyAfter = destroyDate.toISOString();
    } else if (state === "active") {
      updates.suspendedAt = null;
      updates.destroyAfter = null;
    } else if (state === "destroyed") {
      updates.suspendedAt = null;
      updates.destroyAfter = null;
    }

    const result = await this.db
      .update(botInstances)
      .set(updates)
      .where(eq(botInstances.id, id))
      .returning({ id: botInstances.id });
    if (result.length === 0) {
      throw new Error(`Bot instance not found: ${id}`);
    }
    const updated = await this.getById(id);
    if (!updated) throw new Error(`Bot instance not found after update: ${id}`);
    return updated;
  }

  async getResourceTier(botId: string): Promise<string | null> {
    const rows = await this.db
      .select({ resourceTier: botInstances.resourceTier })
      .from(botInstances)
      .where(eq(botInstances.id, botId));
    return rows[0]?.resourceTier ?? null;
  }

  async setResourceTier(botId: string, tier: string): Promise<void> {
    await this.db
      .update(botInstances)
      .set({
        resourceTier: tier,
        updatedAt: sql`(now())`,
      })
      .where(eq(botInstances.id, botId));
  }

  async deleteAllByTenant(tenantId: string): Promise<void> {
    await this.db.delete(botInstances).where(eq(botInstances.tenantId, tenantId));
  }

  async deleteById(instanceId: string): Promise<void> {
    await this.db.delete(botInstances).where(eq(botInstances.id, instanceId));
  }

  async listByNodeWithTier(nodeId: string): Promise<TenantWithTier[]> {
    const rows = await this.db
      .select({
        id: botInstances.id,
        tenantId: botInstances.tenantId,
        name: botInstances.name,
        tier: tenantCustomers.tier,
      })
      .from(botInstances)
      .leftJoin(tenantCustomers, eq(botInstances.tenantId, tenantCustomers.tenant))
      .where(eq(botInstances.nodeId, nodeId))
      .orderBy(
        sql`CASE ${tenantCustomers.tier}
          WHEN 'enterprise' THEN 1
          WHEN 'pro' THEN 2
          WHEN 'starter' THEN 3
          ELSE 4
        END`,
        botInstances.id,
      );

    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      name: r.name,
      tier: r.tier ?? null,
    }));
  }

  async findByTenantAndNode(tenantId: string, nodeId: string): Promise<BotInstance | null> {
    const rows = await this.db
      .select()
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.nodeId, nodeId)));
    return rows[0] ? toInstance(rows[0]) : null;
  }

  async countActiveByTenant(tenantId: string): Promise<number> {
    const row = (
      await this.db
        .select({ count: sql<number>`count(*)` })
        .from(botInstances)
        .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")))
    )[0];
    return row?.count ?? 0;
  }

  async listActiveIdsByTenant(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")));
    return rows.map((r) => r.id);
  }

  async listSuspendedIdsByTenant(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "suspended")));
    return rows.map((r) => r.id);
  }

  async listExpiredSuspendedIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.billingState, "suspended"), sql`${botInstances.destroyAfter}::timestamp <= now()`));
    return rows.map((r) => r.id);
  }

  async suspend(botId: string, graceDays: number): Promise<void> {
    await this.db
      .update(botInstances)
      .set({
        billingState: "suspended",
        suspendedAt: sql`now()`,
        destroyAfter: sql`now() + make_interval(days => ${graceDays})`,
        updatedAt: sql`now()`,
      })
      .where(eq(botInstances.id, botId));
  }

  async reactivate(botId: string): Promise<void> {
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

  async markDestroyed(botId: string): Promise<void> {
    await this.db
      .update(botInstances)
      .set({
        billingState: "destroyed",
        updatedAt: sql`now()`,
      })
      .where(eq(botInstances.id, botId));
  }

  async register(botId: string, tenantId: string, name: string): Promise<void> {
    await this.db.insert(botInstances).values({
      id: botId,
      tenantId,
      name,
      billingState: "active",
    });
  }

  async getStorageTier(botId: string): Promise<string | null> {
    const row = (
      await this.db
        .select({ storageTier: botInstances.storageTier })
        .from(botInstances)
        .where(eq(botInstances.id, botId))
    )[0];
    return row?.storageTier ?? null;
  }

  async setStorageTier(botId: string, tier: string): Promise<void> {
    await this.db
      .update(botInstances)
      .set({ storageTier: tier, updatedAt: sql`now()` })
      .where(eq(botInstances.id, botId));
  }

  async listActiveStorageTiers(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ storageTier: botInstances.storageTier })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), eq(botInstances.billingState, "active")));
    return rows.map((r) => r.storageTier ?? "free");
  }
}

// ---------------------------------------------------------------------------
// Row → Domain mapper
// ---------------------------------------------------------------------------

function toInstance(row: typeof botInstances.$inferSelect): BotInstance {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    nodeId: row.nodeId,
    billingState: row.billingState as BillingState,
    suspendedAt: row.suspendedAt,
    destroyAfter: row.destroyAfter,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByUserId: row.createdByUserId ?? null,
  };
}
