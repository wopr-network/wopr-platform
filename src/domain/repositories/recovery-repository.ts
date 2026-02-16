/**
 * Repository Interface: RecoveryRepository (ASYNC)
 *
 * Manages node failure recovery operations.
 * Tracks recovery events and per-tenant recovery items.
 */
import type {
  RecoveryEvent,
  RecoveryEventStatus,
  RecoveryItem,
  RecoveryItemStatus,
  RecoveryTrigger,
} from "../entities/recovery.js";

export interface RecoveryRepository {
  /**
   * Create a new recovery event.
   */
  createEvent(event: {
    id: string;
    nodeId: string;
    trigger: RecoveryTrigger;
    tenantsTotal: number;
  }): Promise<RecoveryEvent>;

  /**
   * Update a recovery event status.
   */
  updateEvent(
    eventId: string,
    update: {
      status: RecoveryEventStatus;
      tenantsRecovered: number;
      tenantsFailed: number;
      tenantsWaiting: number;
      reportJson: string;
    },
  ): Promise<void>;

  /**
   * Get a recovery event by ID.
   */
  getEvent(eventId: string): Promise<RecoveryEvent | null>;

  /**
   * List recovery events (most recent first).
   */
  listEvents(limit: number): Promise<RecoveryEvent[]>;

  /**
   * Create a recovery item.
   */
  createItem(item: {
    id: string;
    recoveryEventId: string;
    tenant: string;
    sourceNode: string;
    targetNode?: string | null;
    backupKey?: string | null;
    status: RecoveryItemStatus;
    reason?: string | null;
  }): Promise<RecoveryItem>;

  /**
   * Update a recovery item.
   */
  updateItem(
    itemId: string,
    update: {
      targetNode?: string | null;
      status?: RecoveryItemStatus;
      reason?: string | null;
      completedAt?: boolean;
    },
  ): Promise<void>;

  /**
   * Get all items for a recovery event.
   */
  getItemsByEvent(eventId: string): Promise<RecoveryItem[]>;

  /**
   * Get waiting items for a recovery event.
   */
  getWaitingItems(eventId: string): Promise<RecoveryItem[]>;

  /**
   * Get items by tenant.
   */
  getItemsByTenant(tenant: string): Promise<RecoveryItem[]>;
}
