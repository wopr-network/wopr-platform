/**
 * In-Memory Implementation: RecoveryRepository (ASYNC)
 */

import {
  RecoveryEvent,
  type RecoveryEventStatus,
  RecoveryItem,
  type RecoveryItemStatus,
  type RecoveryTrigger,
} from "../../domain/entities/recovery.js";
import type { RecoveryRepository } from "../../domain/repositories/recovery-repository.js";

interface StoredEvent {
  id: string;
  nodeId: string;
  trigger: RecoveryTrigger;
  status: RecoveryEventStatus;
  tenantsTotal: number | null;
  tenantsRecovered: number | null;
  tenantsFailed: number | null;
  tenantsWaiting: number | null;
  startedAt: number;
  completedAt: number | null;
  reportJson: string | null;
}

interface StoredItem {
  id: string;
  recoveryEventId: string;
  tenant: string;
  sourceNode: string;
  targetNode: string | null;
  backupKey: string | null;
  status: RecoveryItemStatus;
  reason: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export class InMemoryRecoveryRepository implements RecoveryRepository {
  private events = new Map<string, StoredEvent>();
  private items = new Map<string, StoredItem>();

  async createEvent(event: {
    id: string;
    nodeId: string;
    trigger: RecoveryTrigger;
    tenantsTotal: number;
  }): Promise<RecoveryEvent> {
    const now = Date.now();
    const stored: StoredEvent = {
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
    };
    this.events.set(event.id, stored);
    return this.toEvent(stored);
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
    const existing = this.events.get(eventId);
    if (!existing) {
      throw new Error(`Event ${eventId} not found`);
    }
    this.events.set(eventId, {
      ...existing,
      status: update.status,
      tenantsRecovered: update.tenantsRecovered,
      tenantsFailed: update.tenantsFailed,
      tenantsWaiting: update.tenantsWaiting,
      completedAt: Date.now(),
      reportJson: update.reportJson,
    });
  }

  async getEvent(eventId: string): Promise<RecoveryEvent | null> {
    const event = this.events.get(eventId);
    return event ? this.toEvent(event) : null;
  }

  async listEvents(limit: number): Promise<RecoveryEvent[]> {
    return Array.from(this.events.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(this.toEvent);
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
    const now = Date.now();
    const stored: StoredItem = {
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
    };
    this.items.set(item.id, stored);
    return this.toItem(stored);
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
    const existing = this.items.get(itemId);
    if (!existing) {
      throw new Error(`Item ${itemId} not found`);
    }
    this.items.set(itemId, {
      ...existing,
      targetNode: update.targetNode !== undefined ? update.targetNode : existing.targetNode,
      status: update.status ?? existing.status,
      reason: update.reason !== undefined ? update.reason : existing.reason,
      completedAt: update.completedAt ? Date.now() : existing.completedAt,
    });
  }

  async getItemsByEvent(eventId: string): Promise<RecoveryItem[]> {
    return Array.from(this.items.values())
      .filter((i) => i.recoveryEventId === eventId)
      .map(this.toItem);
  }

  async getWaitingItems(eventId: string): Promise<RecoveryItem[]> {
    return Array.from(this.items.values())
      .filter((i) => i.recoveryEventId === eventId && i.status === "waiting")
      .map(this.toItem);
  }

  async getItemsByTenant(tenant: string): Promise<RecoveryItem[]> {
    return Array.from(this.items.values())
      .filter((i) => i.tenant === tenant)
      .map(this.toItem);
  }

  private toEvent(stored: StoredEvent): RecoveryEvent {
    return RecoveryEvent.fromRow({
      id: stored.id,
      nodeId: stored.nodeId,
      trigger: stored.trigger,
      status: stored.status,
      tenantsTotal: stored.tenantsTotal,
      tenantsRecovered: stored.tenantsRecovered,
      tenantsFailed: stored.tenantsFailed,
      tenantsWaiting: stored.tenantsWaiting,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
      reportJson: stored.reportJson,
    });
  }

  private toItem(stored: StoredItem): RecoveryItem {
    return RecoveryItem.fromRow({
      id: stored.id,
      recoveryEventId: stored.recoveryEventId,
      tenant: stored.tenant,
      sourceNode: stored.sourceNode,
      targetNode: stored.targetNode,
      backupKey: stored.backupKey,
      status: stored.status,
      reason: stored.reason,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
    });
  }
}
