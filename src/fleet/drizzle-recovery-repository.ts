import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { recoveryEvents, recoveryItems } from "../db/schema/index.js";
import type { IRecoveryRepository } from "./recovery-repository.js";
import type { NewRecoveryEvent, NewRecoveryItem, RecoveryEvent, RecoveryItem } from "./repository-types.js";

function toEvent(row: typeof recoveryEvents.$inferSelect): RecoveryEvent {
  return {
    id: row.id,
    nodeId: row.nodeId,
    trigger: row.trigger,
    status: row.status as RecoveryEvent["status"],
    tenantsTotal: row.tenantsTotal ?? 0,
    tenantsRecovered: row.tenantsRecovered ?? 0,
    tenantsFailed: row.tenantsFailed ?? 0,
    tenantsWaiting: row.tenantsWaiting ?? 0,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    reportJson: row.reportJson ?? null,
  };
}

function toItem(row: typeof recoveryItems.$inferSelect): RecoveryItem {
  return {
    id: row.id,
    recoveryEventId: row.recoveryEventId,
    tenant: row.tenant,
    sourceNode: row.sourceNode,
    targetNode: row.targetNode ?? null,
    backupKey: row.backupKey ?? null,
    status: row.status as RecoveryItem["status"],
    reason: row.reason ?? null,
    retryCount: row.retryCount,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

export class DrizzleRecoveryRepository implements IRecoveryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createEvent(data: NewRecoveryEvent): Promise<RecoveryEvent> {
    const now = Math.floor(Date.now() / 1000);
    const row = {
      id: data.id,
      nodeId: data.nodeId,
      trigger: data.trigger,
      status: "in_progress" as const,
      tenantsTotal: data.tenantsTotal,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 0,
      startedAt: now,
      completedAt: null,
      reportJson: null,
    };
    await this.db.insert(recoveryEvents).values(row);
    return toEvent(row as typeof recoveryEvents.$inferSelect);
  }

  async updateEvent(id: string, data: Partial<Omit<RecoveryEvent, "id" | "nodeId">>): Promise<RecoveryEvent> {
    const rows = await this.db
      .update(recoveryEvents)
      .set(data as Record<string, unknown>)
      .where(eq(recoveryEvents.id, id))
      .returning();
    if (rows.length === 0) {
      throw new Error(`RecoveryEvent not found: ${id}`);
    }
    return toEvent(rows[0]);
  }

  async getEvent(id: string): Promise<RecoveryEvent | null> {
    const rows = await this.db.select().from(recoveryEvents).where(eq(recoveryEvents.id, id));
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async createItem(data: NewRecoveryItem): Promise<RecoveryItem> {
    const now = Math.floor(Date.now() / 1000);
    const row = {
      id: data.id,
      recoveryEventId: data.recoveryEventId,
      tenant: data.tenant,
      sourceNode: data.sourceNode,
      targetNode: null,
      backupKey: data.backupKey,
      status: "waiting" as const,
      reason: null,
      retryCount: 0,
      startedAt: now,
      completedAt: null,
    };
    await this.db.insert(recoveryItems).values(row);
    return toItem(row as typeof recoveryItems.$inferSelect);
  }

  async updateItem(id: string, data: Partial<Omit<RecoveryItem, "id">>): Promise<RecoveryItem> {
    const rows = await this.db
      .update(recoveryItems)
      .set(data as Record<string, unknown>)
      .where(eq(recoveryItems.id, id))
      .returning();
    if (rows.length === 0) {
      throw new Error(`RecoveryItem not found: ${id}`);
    }
    return toItem(rows[0]);
  }

  async listOpenEvents(): Promise<RecoveryEvent[]> {
    const rows = await this.db
      .select()
      .from(recoveryEvents)
      .where(inArray(recoveryEvents.status, ["in_progress", "partial"]));
    return rows.map(toEvent);
  }

  async listEvents(limit: number, status?: RecoveryEvent["status"]): Promise<RecoveryEvent[]> {
    let rows: (typeof recoveryEvents.$inferSelect)[] | undefined;
    if (status) {
      rows = await this.db.select().from(recoveryEvents).where(eq(recoveryEvents.status, status)).limit(limit);
    } else {
      rows = await this.db.select().from(recoveryEvents).limit(limit);
    }
    return rows.map(toEvent);
  }

  async getWaitingItems(eventId: string): Promise<RecoveryItem[]> {
    const rows = await this.db
      .select()
      .from(recoveryItems)
      .where(and(eq(recoveryItems.recoveryEventId, eventId), eq(recoveryItems.status, "waiting")));
    return rows.map(toItem);
  }

  async incrementRetryCount(itemId: string): Promise<void> {
    await this.db
      .update(recoveryItems)
      .set({ retryCount: sql`${recoveryItems.retryCount} + 1` })
      .where(eq(recoveryItems.id, itemId));
  }
}
