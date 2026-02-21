import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema/index.js";
import { botInstances } from "../db/schema/index.js";
import type { BillingState, BotInstance, NewBotInstance } from "./repository-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository interface for bot instance operations. */
export interface IBotInstanceRepository {
  getById(id: string): BotInstance | null;
  listByNode(nodeId: string): BotInstance[];
  listByTenant(tenantId: string): BotInstance[];
  create(data: NewBotInstance): BotInstance;
  reassign(id: string, nodeId: string): BotInstance;
  setBillingState(id: string, state: BillingState): BotInstance;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Drizzle-backed implementation of IBotInstanceRepository. */
export class DrizzleBotInstanceRepository implements IBotInstanceRepository {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  getById(id: string): BotInstance | null {
    const row = this.db.select().from(botInstances).where(eq(botInstances.id, id)).get();
    return row ? toInstance(row) : null;
  }

  listByNode(nodeId: string): BotInstance[] {
    return this.db.select().from(botInstances).where(eq(botInstances.nodeId, nodeId)).all().map(toInstance);
  }

  listByTenant(tenantId: string): BotInstance[] {
    return this.db.select().from(botInstances).where(eq(botInstances.tenantId, tenantId)).all().map(toInstance);
  }

  create(data: NewBotInstance): BotInstance {
    const now = new Date().toISOString();
    this.db
      .insert(botInstances)
      .values({
        id: data.id,
        tenantId: data.tenantId,
        name: data.name,
        nodeId: data.nodeId,
        billingState: data.billingState ?? "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const created = this.getById(data.id);
    if (!created) throw new Error(`Bot instance not found after insert: ${data.id}`);
    return created;
  }

  reassign(id: string, nodeId: string): BotInstance {
    const now = new Date().toISOString();
    const result = this.db.update(botInstances).set({ nodeId, updatedAt: now }).where(eq(botInstances.id, id)).run();
    if (result.changes === 0) {
      throw new Error(`Bot instance not found: ${id}`);
    }
    const updated = this.getById(id);
    if (!updated) throw new Error(`Bot instance not found after update: ${id}`);
    return updated;
  }

  setBillingState(id: string, state: BillingState): BotInstance {
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
      // Clear suspension timestamps — they are no longer meaningful once destroyed.
      updates.suspendedAt = null;
      updates.destroyAfter = null;
    }

    const result = this.db.update(botInstances).set(updates).where(eq(botInstances.id, id)).run();
    if (result.changes === 0) {
      throw new Error(`Bot instance not found: ${id}`);
    }
    const updated = this.getById(id);
    if (!updated) throw new Error(`Bot instance not found after update: ${id}`);
    return updated;
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
  };
}
