/**
 * In-Memory Implementation: BotInstanceRepository (ASYNC)
 */

import { type BillingState, BotInstance } from "../../domain/entities/bot-instance.js";
import type { BotInstanceRepository } from "../../domain/repositories/bot-instance-repository.js";
import type { TenantId } from "../../domain/value-objects/tenant-id.js";

interface StoredBot {
  id: string;
  tenantId: string;
  name: string;
  nodeId: string | null;
  billingState: BillingState;
  suspendedAt: string | null;
  destroyAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export class InMemoryBotInstanceRepository implements BotInstanceRepository {
  private bots = new Map<string, StoredBot>();

  async get(botId: string): Promise<BotInstance | null> {
    const bot = this.bots.get(botId);
    return bot ? this.toBotInstance(bot) : null;
  }

  async listForTenant(tenantId: TenantId): Promise<BotInstance[]> {
    const tenantStr = tenantId.toString();
    return Array.from(this.bots.values())
      .filter((b) => b.tenantId === tenantStr)
      .map(this.toBotInstance);
  }

  async listByNode(nodeId: string): Promise<BotInstance[]> {
    return Array.from(this.bots.values())
      .filter((b) => b.nodeId === nodeId)
      .map(this.toBotInstance);
  }

  async listActiveForTenant(tenantId: TenantId): Promise<BotInstance[]> {
    const tenantStr = tenantId.toString();
    return Array.from(this.bots.values())
      .filter((b) => b.tenantId === tenantStr && b.billingState === "active")
      .map(this.toBotInstance);
  }

  async assignToNode(botId: string, nodeId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }
    bot.nodeId = nodeId;
    bot.updatedAt = new Date().toISOString();
  }

  async unassignFromNode(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }
    bot.nodeId = null;
    bot.updatedAt = new Date().toISOString();
  }

  async create(botId: string, tenantId: TenantId, name: string): Promise<BotInstance> {
    const now = new Date().toISOString();
    const bot: StoredBot = {
      id: botId,
      tenantId: tenantId.toString(),
      name,
      nodeId: null,
      billingState: "active",
      suspendedAt: null,
      destroyAfter: null,
      createdAt: now,
      updatedAt: now,
    };
    this.bots.set(botId, bot);
    return this.toBotInstance(bot);
  }

  async delete(botId: string): Promise<void> {
    this.bots.delete(botId);
  }

  private toBotInstance(stored: StoredBot): BotInstance {
    return BotInstance.fromRow({
      id: stored.id,
      tenantId: stored.tenantId,
      name: stored.name,
      nodeId: stored.nodeId,
      billingState: stored.billingState,
      suspendedAt: stored.suspendedAt,
      destroyAfter: stored.destroyAfter,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    });
  }
}
