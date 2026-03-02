import type { BillingState, BotInstance, NewBotInstance, TenantWithTier } from "./repository-types.js";

// Re-export domain types for consumers that imported them from here
export type { BillingState, BotInstance, NewBotInstance, TenantWithTier };

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
  /** List bot instances on a node with tier priority (enterprise > pro > starter > free). */
  listByNodeWithTier(nodeId: string): Promise<TenantWithTier[]>;
  /** Find a bot instance by tenant ID and node ID. */
  findByTenantAndNode(tenantId: string, nodeId: string): Promise<BotInstance | null>;
}
