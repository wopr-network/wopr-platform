/**
 * Repository Interface: BotInstanceRepository (ASYNC)
 *
 * Manages bot instance data for fleet operations (node assignment, recovery).
 * Billing lifecycle is handled by BotBillingRepository.
 */

import type { BotInstance } from "../entities/bot-instance.js";
import type { TenantId } from "../value-objects/tenant-id.js";

export interface BotInstanceRepository {
  /**
   * Get a bot instance by ID.
   */
  get(botId: string): Promise<BotInstance | null>;

  /**
   * List all bots for a tenant.
   */
  listForTenant(tenantId: TenantId): Promise<BotInstance[]>;

  /**
   * List all bots deployed on a specific node.
   */
  listByNode(nodeId: string): Promise<BotInstance[]>;

  /**
   * List all active bots for a tenant.
   */
  listActiveForTenant(tenantId: TenantId): Promise<BotInstance[]>;

  /**
   * Assign a bot to a node.
   */
  assignToNode(botId: string, nodeId: string): Promise<void>;

  /**
   * Remove node assignment from a bot.
   */
  unassignFromNode(botId: string): Promise<void>;

  /**
   * Create a new bot instance record.
   */
  create(botId: string, tenantId: TenantId, name: string): Promise<BotInstance>;

  /**
   * Delete a bot instance record.
   */
  delete(botId: string): Promise<void>;
}
