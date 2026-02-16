/**
 * Bot billing lifecycle manager.
 *
 * Handles suspend/reactivate/destroy transitions and provides
 * active-bot-count queries for the daily runtime cron.
 * 
 * MIGRATED: Now uses BotBillingRepository instead of direct Drizzle
 */
import type { BotBillingRepository } from '../../domain/repositories/bot-billing-repository.js';
import { TenantId } from '../../domain/value-objects/tenant-id.js';

export type BillingState = 'active' | 'suspended' | 'destroyed';

export const SUSPENSION_GRACE_DAYS = 30;

export class BotBilling {
  constructor(private readonly repository: BotBillingRepository) {}

  getActiveBotCount(tenantId: string): number {
    return Promise.resolve(this.repository.getActiveBotCount(TenantId.create(tenantId))) as unknown as number;
  }

  async suspendBot(botId: string): Promise<void> {
    await this.repository.suspendBot(botId);
  }

  async suspendAllForTenant(tenantId: string): Promise<string[]> {
    return this.repository.suspendAllForTenant(TenantId.create(tenantId));
  }

  async reactivateBot(botId: string): Promise<void> {
    await this.repository.reactivateBot(botId);
  }

  async checkReactivation(tenantId: string, creditRepository: { getBalance(tenantId: TenantId): Promise<{ balance: { toCents(): number } }> }): Promise<string[]> {
    const balance = await creditRepository.getBalance(TenantId.create(tenantId));
    
    if (balance.balance.toCents() === 0) {
      return [];
    }

    const suspended = await this.repository.getSuspendedBots(TenantId.create(tenantId));

    for (const bot of suspended) {
      await this.reactivateBot(bot.id);
    }

    return suspended.map((b) => b.id);
  }

  async destroyBot(botId: string): Promise<void> {
    await this.repository.destroyBot(botId);
  }

  async destroyExpiredBots(): Promise<string[]> {
    return this.repository.destroyExpiredBots();
  }

  async getBotBilling(botId: string) {
    return this.repository.getBotBilling(botId);
  }

  async listForTenant(tenantId: string) {
    return this.repository.listForTenant(TenantId.create(tenantId));
  }

  async registerBot(botId: string, tenantId: string, name: string): Promise<void> {
    await this.repository.registerBot(botId, TenantId.create(tenantId), name);
  }
}
