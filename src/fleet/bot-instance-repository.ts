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

  // ---------------------------------------------------------------------------
  // Billing lifecycle methods (used by BotBilling)
  // ---------------------------------------------------------------------------

  /** Count active bots for a tenant. */
  countActiveByTenant(tenantId: string): Promise<number>;
  /** List active bot IDs for a tenant. */
  listActiveIdsByTenant(tenantId: string): Promise<string[]>;
  /** List suspended bot IDs for a tenant. */
  listSuspendedIdsByTenant(tenantId: string): Promise<string[]>;
  /** List IDs of suspended bots past their destroy_after deadline. */
  listExpiredSuspendedIds(): Promise<string[]>;
  /** Update billing fields for suspension. */
  suspend(botId: string, graceDays: number): Promise<void>;
  /** Clear suspension and reactivate. */
  reactivate(botId: string): Promise<void>;
  /** Mark a bot as destroyed. */
  markDestroyed(botId: string): Promise<void>;
  /** Register a new bot instance. */
  register(botId: string, tenantId: string, name: string): Promise<void>;
  /** Get storage tier for a bot. */
  getStorageTier(botId: string): Promise<string | null>;
  /** Set storage tier for a bot. */
  setStorageTier(botId: string, tier: string): Promise<void>;
  /** List storage tiers for all active bots of a tenant. */
  listActiveStorageTiers(tenantId: string): Promise<string[]>;
}
