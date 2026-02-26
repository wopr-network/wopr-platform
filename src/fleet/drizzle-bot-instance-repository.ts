import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { botInstances } from "../db/schema/index.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { BillingState, BotInstance, NewBotInstance } from "./repository-types.js";

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
