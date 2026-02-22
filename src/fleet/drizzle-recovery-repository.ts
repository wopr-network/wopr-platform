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

  createEvent(data: NewRecoveryEvent): RecoveryEvent {
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
    this.db.insert(recoveryEvents).values(row).run();
    return toEvent(row as typeof recoveryEvents.$inferSelect);
  }

  updateEvent(id: string, data: Partial<Omit<RecoveryEvent, "id" | "nodeId">>): RecoveryEvent {
    const rows = this.db
      .update(recoveryEvents)
      .set(data as Record<string, unknown>)
      .where(eq(recoveryEvents.id, id))
      .returning()
      .all();
    if (rows.length === 0) {
      throw new Error(`RecoveryEvent not found: ${id}`);
    }
    return toEvent(rows[0]);
  }

  getEvent(id: string): RecoveryEvent | null {
    const row = this.db.select().from(recoveryEvents).where(eq(recoveryEvents.id, id)).get();
    return row ? toEvent(row) : null;
  }

  createItem(data: NewRecoveryItem): RecoveryItem {
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
    this.db.insert(recoveryItems).values(row).run();
    return toItem(row as typeof recoveryItems.$inferSelect);
  }

  updateItem(id: string, data: Partial<Omit<RecoveryItem, "id">>): RecoveryItem {
    const rows = this.db
      .update(recoveryItems)
      .set(data as Record<string, unknown>)
      .where(eq(recoveryItems.id, id))
      .returning()
      .all();
    if (rows.length === 0) {
      throw new Error(`RecoveryItem not found: ${id}`);
    }
    return toItem(rows[0]);
  }

  listOpenEvents(): RecoveryEvent[] {
    return this.db
      .select()
      .from(recoveryEvents)
      .where(inArray(recoveryEvents.status, ["in_progress", "partial"]))
      .all()
      .map(toEvent);
  }

  listEvents(limit: number, status?: RecoveryEvent["status"]): RecoveryEvent[] {
    const query = this.db.select().from(recoveryEvents);
    const rows = status ? query.where(eq(recoveryEvents.status, status)).limit(limit).all() : query.limit(limit).all();
    return rows.map(toEvent);
  }

  getWaitingItems(eventId: string): RecoveryItem[] {
    return this.db
      .select()
      .from(recoveryItems)
      .where(and(eq(recoveryItems.recoveryEventId, eventId), eq(recoveryItems.status, "waiting")))
      .all()
      .map(toItem);
  }

  incrementRetryCount(itemId: string): void {
    this.db
      .update(recoveryItems)
      .set({ retryCount: sql`${recoveryItems.retryCount} + 1` })
      .where(eq(recoveryItems.id, itemId))
      .run();
  }
}
