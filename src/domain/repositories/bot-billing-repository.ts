/**
 * Repository Interface: BotBillingRepository (ASYNC)
 * 
 * All operations are async for future flexibility.
 * Handles bot billing lifecycle: suspend, reactivate, destroy.
 */
import type { TenantId } from '../value-objects/tenant-id.js';
import type { BotInstance, BillingState } from '../entities/bot-instance.js';

export interface BotBillingRepository {
  /**
   * Register a new bot instance for billing.
   */
  registerBot(botId: string, tenantId: TenantId, name: string): Promise<void>;

  /**
   * Get billing info for a single bot.
   */
  getBotBilling(botId: string): Promise<BotInstance | null>;

  /**
   * Count active bots for a tenant.
   */
  getActiveBotCount(tenantId: TenantId): Promise<number>;

  /**
   * List all bots for a tenant (any billing state).
   */
  listForTenant(tenantId: TenantId): Promise<BotInstance[]>;

  /**
   * Suspend a bot: stop billing, set destroy timer.
   * Sets billingState='suspended', suspendedAt=now, destroyAfter=now+30 days.
   */
  suspendBot(botId: string): Promise<void>;

  /**
   * Suspend ALL active bots for a tenant.
   * Returns list of suspended bot IDs.
   */
  suspendAllForTenant(tenantId: TenantId): Promise<string[]>;

  /**
   * Reactivate a suspended bot.
   * Clears suspendedAt and destroyAfter, sets billingState='active'.
   * Only reactivates bots that are currently suspended (not destroyed).
   */
  reactivateBot(botId: string): Promise<void>;

  /**
   * Get all suspended bots for a tenant.
   */
  getSuspendedBots(tenantId: TenantId): Promise<BotInstance[]>;

  /**
   * Mark a bot as destroyed.
   */
  destroyBot(botId: string): Promise<void>;

  /**
   * Find and mark as destroyed all bots whose suspension grace period has expired.
   * Returns IDs of destroyed bots.
   */
  destroyExpiredBots(): Promise<string[]>;

  /**
   * Update the node where a bot is deployed.
   */
  assignToNode(botId: string, nodeId: string): Promise<void>;
}
