/**
 * Drizzle Implementation: RecoveryRepository (ASYNC API)
 */
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { recoveryEvents, recoveryItems } from "../../db/schema/recovery-events.js";
import {
  RecoveryEvent,
  type RecoveryEventStatus,
  RecoveryItem,
  type RecoveryItemStatus,
  type RecoveryTrigger,
} from "../../domain/entities/recovery.js";
import type { RecoveryRepository } from "../../domain/repositories/recovery-repository.js";

function rowToRecoveryEvent(row: typeof recoveryEvents.$inferSelect): RecoveryEvent {
  return RecoveryEvent.fromRow({
    id: row.id,
    nodeId: row.nodeId,
    trigger: row.trigger as RecoveryTrigger,
    status: row.status as RecoveryEventStatus,
    tenantsTotal: row.tenantsTotal,
    tenantsRecovered: row.tenantsRecovered,
    tenantsFailed: row.tenantsFailed,
    tenantsWaiting: row.tenantsWaiting,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    reportJson: row.reportJson,
  });
}

function rowToRecoveryItem(row: typeof recoveryItems.$inferSelect): RecoveryItem {
  return RecoveryItem.fromRow({
    id: row.id,
    recoveryEventId: row.recoveryEventId,
    tenant: row.tenant,
    sourceNode: row.sourceNode,
    targetNode: row.targetNode,
    backupKey: row.backupKey,
    status: row.status as RecoveryItemStatus,
    reason: row.reason,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  });
}

export class DrizzleRecoveryRepository implements RecoveryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createEvent(event: {
    id: string;
    nodeId: string;
    trigger: RecoveryTrigger;
    tenantsTotal: number;
  }): Promise<RecoveryEvent> {
    const now = Math.floor(Date.now() / 1000);

    await this.db
      .insert(recoveryEvents)
      .values({
        id: event.id,
        nodeId: event.nodeId,
        trigger: event.trigger,
        status: "in_progress",
        tenantsTotal: event.tenantsTotal,
        tenantsRecovered: 0,
        tenantsFailed: 0,
        tenantsWaiting: 0,
        startedAt: now,
        completedAt: null,
        reportJson: null,
      })
      .run();

    const evt = await this.getEvent(event.id);
    if (!evt) {
      throw new Error("Failed to create recovery event");
    }
    return evt;
  }

  async updateEvent(
    eventId: string,
    update: {
      status: RecoveryEventStatus;
      tenantsRecovered: number;
      tenantsFailed: number;
      tenantsWaiting: number;
      reportJson: string;
    },
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    await this.db
      .update(recoveryEvents)
      .set({
        status: update.status,
        tenantsRecovered: update.tenantsRecovered,
        tenantsFailed: update.tenantsFailed,
        tenantsWaiting: update.tenantsWaiting,
        completedAt: now,
        reportJson: update.reportJson,
      })
      .where(eq(recoveryEvents.id, eventId))
      .run();
  }

  async getEvent(eventId: string): Promise<RecoveryEvent | null> {
    const row = this.db.select().from(recoveryEvents).where(eq(recoveryEvents.id, eventId)).get();

    return row ? rowToRecoveryEvent(row) : null;
  }

  async listEvents(limit: number): Promise<RecoveryEvent[]> {
    const rows = this.db.select().from(recoveryEvents).limit(limit).all();

    return rows.map(rowToRecoveryEvent).reverse();
  }

  async createItem(item: {
    id: string;
    recoveryEventId: string;
    tenant: string;
    sourceNode: string;
    targetNode?: string | null;
    backupKey?: string | null;
    status: RecoveryItemStatus;
    reason?: string | null;
  }): Promise<RecoveryItem> {
    const now = Math.floor(Date.now() / 1000);

    await this.db
      .insert(recoveryItems)
      .values({
        id: item.id,
        recoveryEventId: item.recoveryEventId,
        tenant: item.tenant,
        sourceNode: item.sourceNode,
        targetNode: item.targetNode ?? null,
        backupKey: item.backupKey ?? null,
        status: item.status,
        reason: item.reason ?? null,
        startedAt: now,
        completedAt: item.status === "waiting" ? null : now,
      })
      .run();

    const row = await this.db.select().from(recoveryItems).where(eq(recoveryItems.id, item.id)).get();

    if (!row) {
      throw new Error("Failed to create recovery item");
    }
    return rowToRecoveryItem(row);
  }

  async updateItem(
    itemId: string,
    update: {
      targetNode?: string | null;
      status?: RecoveryItemStatus;
      reason?: string | null;
      completedAt?: boolean;
    },
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const setFields: Record<string, unknown> = {};

    if (update.targetNode !== undefined) {
      setFields.targetNode = update.targetNode;
    }
    if (update.status !== undefined) {
      setFields.status = update.status;
    }
    if (update.reason !== undefined) {
      setFields.reason = update.reason;
    }
    if (update.completedAt) {
      setFields.completedAt = now;
    }

    setFields.updatedAt = now;

    await this.db.update(recoveryItems).set(setFields).where(eq(recoveryItems.id, itemId)).run();
  }

  async getItemsByEvent(eventId: string): Promise<RecoveryItem[]> {
    const rows = this.db.select().from(recoveryItems).where(eq(recoveryItems.recoveryEventId, eventId)).all();

    return rows.map(rowToRecoveryItem);
  }

  async getWaitingItems(eventId: string): Promise<RecoveryItem[]> {
    const rows = this.db.select().from(recoveryItems).where(eq(recoveryItems.recoveryEventId, eventId)).all();

    return rows.filter((r) => r.status === "waiting").map(rowToRecoveryItem);
  }

  async getItemsByTenant(tenant: string): Promise<RecoveryItem[]> {
    const rows = this.db.select().from(recoveryItems).where(eq(recoveryItems.tenant, tenant)).all();

    return rows.map(rowToRecoveryItem);
  }
}
