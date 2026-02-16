/**
 * In-Memory Implementation: BotBillingRepository (ASYNC)
 * 
 * For fast unit testing without database.
 */
import type { BotBillingRepository } from '../../domain/repositories/bot-billing-repository.js';
import { TenantId } from '../../domain/value-objects/tenant-id.js';
import { BotInstance, type BillingState } from '../../domain/entities/bot-instance.js';

interface StoredBot {
  id: string;
  tenantId: string;
  name: string;
  nodeId: string | null;
  billingState: BillingState;
  suspendedAt: Date | null;
  destroyAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SUSPENSION_GRACE_DAYS = 30;

export class InMemoryBotBillingRepository implements BotBillingRepository {
  private bots = new Map<string, StoredBot>();

  private getBot(id: string): StoredBot | undefined {
    return this.bots.get(id);
  }

  private setBot(id: string, bot: StoredBot): void {
    this.bots.set(id, bot);
  }

  async registerBot(botId: string, tenantId: TenantId, name: string): Promise<void> {
    const now = new Date();
    this.setBot(botId, {
      id: botId,
      tenantId: tenantId.toString(),
      name,
      nodeId: null,
      billingState: 'active',
      suspendedAt: null,
      destroyAfter: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async getBotBilling(botId: string): Promise<BotInstance | null> {
    const bot = this.getBot(botId);
    if (!bot) return null;
    return this.toBotInstance(bot);
  }

  async getActiveBotCount(tenantId: TenantId): Promise<number> {
    let count = 0;
    for (const bot of this.bots.values()) {
      if (bot.tenantId === tenantId.toString() && bot.billingState === 'active') {
        count++;
      }
    }
    return count;
  }

  async listForTenant(tenantId: TenantId): Promise<BotInstance[]> {
    const result: BotInstance[] = [];
    for (const bot of this.bots.values()) {
      if (bot.tenantId === tenantId.toString()) {
        result.push(this.toBotInstance(bot));
      }
    }
    return result;
  }

  async suspendBot(botId: string): Promise<void> {
    const bot = this.getBot(botId);
    if (!bot) return;

    const now = new Date();
    const destroyAfter = new Date(now);
    destroyAfter.setDate(destroyAfter.getDate() + SUSPENSION_GRACE_DAYS);

    this.setBot(botId, {
      ...bot,
      billingState: 'suspended',
      suspendedAt: now,
      destroyAfter,
      updatedAt: now,
    });
  }

  async suspendAllForTenant(tenantId: TenantId): Promise<string[]> {
    const suspendedIds: string[] = [];
    for (const bot of this.bots.values()) {
      if (bot.tenantId === tenantId.toString() && bot.billingState === 'active') {
        await this.suspendBot(bot.id);
        suspendedIds.push(bot.id);
      }
    }
    return suspendedIds;
  }

  async reactivateBot(botId: string): Promise<void> {
    const bot = this.getBot(botId);
    if (!bot) return;
    if (bot.billingState !== 'suspended') return;

    const now = new Date();
    this.setBot(botId, {
      ...bot,
      billingState: 'active',
      suspendedAt: null,
      destroyAfter: null,
      updatedAt: now,
    });
  }

  async getSuspendedBots(tenantId: TenantId): Promise<BotInstance[]> {
    const result: BotInstance[] = [];
    for (const bot of this.bots.values()) {
      if (bot.tenantId === tenantId.toString() && bot.billingState === 'suspended') {
        result.push(this.toBotInstance(bot));
      }
    }
    return result;
  }

  async destroyBot(botId: string): Promise<void> {
    const bot = this.getBot(botId);
    if (!bot) return;

    this.setBot(botId, {
      ...bot,
      billingState: 'destroyed',
      updatedAt: new Date(),
    });
  }

  async destroyExpiredBots(): Promise<string[]> {
    const now = new Date();
    const destroyedIds: string[] = [];

    for (const bot of this.bots.values()) {
      if (bot.billingState === 'suspended' && bot.destroyAfter && bot.destroyAfter <= now) {
        await this.destroyBot(bot.id);
        destroyedIds.push(bot.id);
      }
    }

    return destroyedIds;
  }

  async assignToNode(botId: string, nodeId: string): Promise<void> {
    const bot = this.getBot(botId);
    if (!bot) return;

    this.setBot(botId, {
      ...bot,
      nodeId,
      updatedAt: new Date(),
    });
  }

  clear(): void {
    this.bots.clear();
  }

  setDestroyAfter(botId: string, date: Date): void {
    const bot = this.getBot(botId);
    if (bot) {
      this.setBot(botId, { ...bot, destroyAfter: date });
    }
  }

  private toBotInstance(bot: StoredBot): BotInstance {
    return new BotInstance({
      id: bot.id,
      tenantId: TenantId.create(bot.tenantId),
      name: bot.name,
      nodeId: bot.nodeId,
      billingState: bot.billingState,
      suspendedAt: bot.suspendedAt,
      destroyAfter: bot.destroyAfter,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    });
  }
}
