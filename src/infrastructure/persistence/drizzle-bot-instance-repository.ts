/**
 * Drizzle Implementation: BotInstanceRepository (ASYNC API)
 */
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { botInstances } from "../../db/schema/bot-instances.js";
import { type BillingState, BotInstance } from "../../domain/entities/bot-instance.js";
import type { BotInstanceRepository } from "../../domain/repositories/bot-instance-repository.js";
import type { TenantId } from "../../domain/value-objects/tenant-id.js";

function rowToBotInstance(row: typeof botInstances.$inferSelect): BotInstance {
  return BotInstance.fromRow({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    nodeId: row.nodeId,
    billingState: row.billingState as BillingState,
    suspendedAt: row.suspendedAt,
    destroyAfter: row.destroyAfter,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class DrizzleBotInstanceRepository implements BotInstanceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(botId: string): Promise<BotInstance | null> {
    const row = this.db.select().from(botInstances).where(eq(botInstances.id, botId)).get();

    return row ? rowToBotInstance(row) : null;
  }

  async listForTenant(tenantId: TenantId): Promise<BotInstance[]> {
    const rows = this.db.select().from(botInstances).where(eq(botInstances.tenantId, tenantId.toString())).all();

    return rows.map(rowToBotInstance);
  }

  async listByNode(nodeId: string): Promise<BotInstance[]> {
    const rows = this.db.select().from(botInstances).where(eq(botInstances.nodeId, nodeId)).all();

    return rows.map(rowToBotInstance);
  }

  async listActiveForTenant(tenantId: TenantId): Promise<BotInstance[]> {
    const rows = this.db.select().from(botInstances).where(eq(botInstances.tenantId, tenantId.toString())).all();

    return rows.filter((r) => r.billingState === "active").map(rowToBotInstance);
  }

  async assignToNode(botId: string, nodeId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(botInstances).set({ nodeId, updatedAt: now }).where(eq(botInstances.id, botId)).run();
  }

  async unassignFromNode(botId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(botInstances).set({ nodeId: null, updatedAt: now }).where(eq(botInstances.id, botId)).run();
  }

  async create(botId: string, tenantId: TenantId, name: string): Promise<BotInstance> {
    const now = new Date().toISOString();
    await this.db
      .insert(botInstances)
      .values({
        id: botId,
        tenantId: tenantId.toString(),
        name,
        billingState: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const bot = await this.get(botId);
    if (!bot) {
      throw new Error("Failed to create bot");
    }
    return bot;
  }

  async delete(botId: string): Promise<void> {
    await this.db.delete(botInstances).where(eq(botInstances.id, botId)).run();
  }
}
