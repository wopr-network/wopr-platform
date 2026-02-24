import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { vpsSubscriptions } from "../db/schema/vps-subscriptions.js";
import type { NewVpsSubscription, VpsStatus, VpsSubscription } from "./repository-types.js";

export interface IVpsRepository {
  getByBotId(botId: string): VpsSubscription | null;
  getBySubscriptionId(subId: string): VpsSubscription | null;
  listByTenant(tenantId: string): VpsSubscription[];
  create(sub: NewVpsSubscription): void;
  updateStatus(botId: string, status: VpsStatus): void;
  setSshPublicKey(botId: string, key: string): void;
  setTunnelId(botId: string, tunnelId: string): void;
  delete(botId: string): void;
}

export class DrizzleVpsRepository implements IVpsRepository {
  constructor(private readonly db: DrizzleDb) {}

  getByBotId(botId: string): VpsSubscription | null {
    const row = this.db.select().from(vpsSubscriptions).where(eq(vpsSubscriptions.botId, botId)).get();
    return row ? mapRow(row) : null;
  }

  getBySubscriptionId(subId: string): VpsSubscription | null {
    const row = this.db.select().from(vpsSubscriptions).where(eq(vpsSubscriptions.stripeSubscriptionId, subId)).get();
    return row ? mapRow(row) : null;
  }

  listByTenant(tenantId: string): VpsSubscription[] {
    return this.db.select().from(vpsSubscriptions).where(eq(vpsSubscriptions.tenantId, tenantId)).all().map(mapRow);
  }

  create(sub: NewVpsSubscription): void {
    this.db
      .insert(vpsSubscriptions)
      .values({
        botId: sub.botId,
        tenantId: sub.tenantId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        stripeCustomerId: sub.stripeCustomerId,
        hostname: sub.hostname,
      })
      .run();
  }

  updateStatus(botId: string, status: VpsStatus): void {
    this.db
      .update(vpsSubscriptions)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(vpsSubscriptions.botId, botId))
      .run();
  }

  setSshPublicKey(botId: string, key: string): void {
    this.db
      .update(vpsSubscriptions)
      .set({ sshPublicKey: key, updatedAt: new Date().toISOString() })
      .where(eq(vpsSubscriptions.botId, botId))
      .run();
  }

  setTunnelId(botId: string, tunnelId: string): void {
    this.db
      .update(vpsSubscriptions)
      .set({ cloudflareTunnelId: tunnelId, updatedAt: new Date().toISOString() })
      .where(eq(vpsSubscriptions.botId, botId))
      .run();
  }

  delete(botId: string): void {
    this.db.delete(vpsSubscriptions).where(eq(vpsSubscriptions.botId, botId)).run();
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
