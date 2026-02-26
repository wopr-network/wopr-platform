import type { NewRecoveryEvent, NewRecoveryItem, RecoveryEvent, RecoveryItem } from "./repository-types.js";

export interface IRecoveryRepository {
  createEvent(data: NewRecoveryEvent): Promise<RecoveryEvent>;
  updateEvent(id: string, data: Partial<Omit<RecoveryEvent, "id" | "nodeId">>): Promise<RecoveryEvent>;
  getEvent(id: string): Promise<RecoveryEvent | null>;
  createItem(data: NewRecoveryItem): Promise<RecoveryItem>;
  updateItem(id: string, data: Partial<Omit<RecoveryItem, "id">>): Promise<RecoveryItem>;
  listOpenEvents(): Promise<RecoveryEvent[]>;
  listEvents(limit: number, status?: RecoveryEvent["status"]): Promise<RecoveryEvent[]>;
  getWaitingItems(eventId: string): Promise<RecoveryItem[]>;
  incrementRetryCount(itemId: string): Promise<void>;
}
