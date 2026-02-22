import type { BillingState, BotInstance, NewBotInstance } from "./repository-types.js";

// Re-export domain types for consumers that imported them from here
export type { BillingState, BotInstance, NewBotInstance };

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
