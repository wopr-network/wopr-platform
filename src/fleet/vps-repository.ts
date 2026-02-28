import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { vpsSubscriptions } from "../db/schema/vps-subscriptions.js";
import type { NewVpsSubscription, VpsStatus, VpsSubscription } from "./repository-types.js";

export interface IVpsRepository {
  getByBotId(botId: string): Promise<VpsSubscription | null>;
  getBySubscriptionId(subId: string): Promise<VpsSubscription | null>;
  listByTenant(tenantId: string): Promise<VpsSubscription[]>;
  create(sub: NewVpsSubscription): Promise<void>;
  updateStatus(botId: string, status: VpsStatus): Promise<void>;
  setSshPublicKey(botId: string, key: string): Promise<void>;
  setTunnelId(botId: string, tunnelId: string): Promise<void>;
  delete(botId: string): Promise<void>;
  deleteAllByTenant(tenantId: string): Promise<void>;
}

export class DrizzleVpsRepository implements IVpsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBotId(botId: string): Promise<VpsSubscription | null> {
    const rows = await this.db.select().from(vpsSubscriptions).where(eq(vpsSubscriptions.botId, botId));
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async getBySubscriptionId(subId: string): Promise<VpsSubscription | null> {
    const rows = await this.db.select().from(vpsSubscriptions).where(eq(vpsSubscriptions.stripeSubscriptionId, subId));
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listByTenant(tenantId: string): Promise<VpsSubscription[]> {
    const rows = await this.db.select().from(vpsSubscriptions).where(eq(vpsSubscriptions.tenantId, tenantId));
    return rows.map(mapRow);
  }

  async create(sub: NewVpsSubscription): Promise<void> {
    await this.db.insert(vpsSubscriptions).values({
      botId: sub.botId,
      tenantId: sub.tenantId,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      stripeCustomerId: sub.stripeCustomerId,
      hostname: sub.hostname,
    });
  }

  async updateStatus(botId: string, status: VpsStatus): Promise<void> {
    await this.db
      .update(vpsSubscriptions)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(vpsSubscriptions.botId, botId));
  }

  async setSshPublicKey(botId: string, key: string): Promise<void> {
    await this.db
      .update(vpsSubscriptions)
      .set({ sshPublicKey: key, updatedAt: new Date().toISOString() })
      .where(eq(vpsSubscriptions.botId, botId));
  }

  async setTunnelId(botId: string, tunnelId: string): Promise<void> {
    await this.db
      .update(vpsSubscriptions)
      .set({ cloudflareTunnelId: tunnelId, updatedAt: new Date().toISOString() })
      .where(eq(vpsSubscriptions.botId, botId));
  }

  async delete(botId: string): Promise<void> {
    await this.db.delete(vpsSubscriptions).where(eq(vpsSubscriptions.botId, botId));
  }

  async deleteAllByTenant(tenantId: string): Promise<void> {
    await this.db.delete(vpsSubscriptions).where(eq(vpsSubscriptions.tenantId, tenantId));
  }
}

function mapRow(row: typeof vpsSubscriptions.$inferSelect): VpsSubscription {
  return {
    botId: row.botId,
    tenantId: row.tenantId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeCustomerId: row.stripeCustomerId,
    status: row.status as VpsStatus,
    sshPublicKey: row.sshPublicKey,
    cloudflareTunnelId: row.cloudflareTunnelId,
    hostname: row.hostname,
    diskSizeGb: row.diskSizeGb,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
