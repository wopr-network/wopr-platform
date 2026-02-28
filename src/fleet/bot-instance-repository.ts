import type { BillingState, BotInstance, NewBotInstance } from "./repository-types.js";

// Re-export domain types for consumers that imported them from here
export type { BillingState, BotInstance, NewBotInstance };

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Repository interface for bot instance operations. */
export interface IBotInstanceRepository {
  getById(id: string): Promise<BotInstance | null>;
  listByNode(nodeId: string): Promise<BotInstance[]>;
  listByTenant(tenantId: string): Promise<BotInstance[]>;
  create(data: NewBotInstance): Promise<BotInstance>;
  reassign(id: string, nodeId: string): Promise<BotInstance>;
  setBillingState(id: string, state: BillingState): Promise<BotInstance>;
  getResourceTier(botId: string): Promise<string | null>;
  setResourceTier(botId: string, tier: string): Promise<void>;
  deleteAllByTenant(tenantId: string): Promise<void>;
}
