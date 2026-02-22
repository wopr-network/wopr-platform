import type { NewRecoveryEvent, NewRecoveryItem, RecoveryEvent, RecoveryItem } from "./repository-types.js";

export interface IRecoveryRepository {
  createEvent(data: NewRecoveryEvent): RecoveryEvent;
  updateEvent(id: string, data: Partial<Omit<RecoveryEvent, "id" | "nodeId">>): RecoveryEvent;
  getEvent(id: string): RecoveryEvent | null;
  createItem(data: NewRecoveryItem): RecoveryItem;
  updateItem(id: string, data: Partial<Omit<RecoveryItem, "id">>): RecoveryItem;
  listOpenEvents(): RecoveryEvent[];
  getWaitingItems(eventId: string): RecoveryItem[];
  incrementRetryCount(itemId: string): void;
}
