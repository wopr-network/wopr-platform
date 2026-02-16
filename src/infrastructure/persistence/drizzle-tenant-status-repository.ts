/**
 * Drizzle Implementation: TenantStatusRepository (ASYNC API)
 */
import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantStatus } from "../../db/schema/tenant-status.js";
import { type TenantAccountStatus, TenantStatus } from "../../domain/entities/tenant-status.js";
import type { TenantStatusRepository } from "../../domain/repositories/tenant-status-repository.js";
import type { TenantId } from "../../domain/value-objects/tenant-id.js";

const GRACE_PERIOD_DAYS = 3;
const BAN_DELETE_DAYS = 30;

function rowToTenantStatus(row: typeof tenantStatus.$inferSelect): TenantStatus {
  return TenantStatus.fromRow({
    tenantId: row.tenantId,
    status: row.status as TenantAccountStatus,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt,
    statusChangedBy: row.statusChangedBy,
    graceDeadline: row.graceDeadline,
    dataDeleteAfter: row.dataDeleteAfter,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class DrizzleTenantStatusRepository implements TenantStatusRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(tenantId: TenantId): Promise<TenantStatus | null> {
    const row = this.db.select().from(tenantStatus).where(eq(tenantStatus.tenantId, tenantId.toString())).get();

    return row ? rowToTenantStatus(row) : null;
  }

  async getStatus(tenantId: TenantId): Promise<TenantAccountStatus> {
    const row = await this.get(tenantId);
    return row?.status ?? "active";
  }

  async ensureExists(tenantId: TenantId): Promise<void> {
    this.db
      .insert(tenantStatus)
      .values({ tenantId: tenantId.toString(), status: "active" })
      .onConflictDoNothing()
      .run();
  }

  async suspend(tenantId: TenantId, reason: string, adminUserId: string): Promise<void> {
    const now = Date.now();
    await this.ensureExists(tenantId);

    this.db
      .update(tenantStatus)
      .set({
        status: "suspended",
        statusReason: reason,
        statusChangedAt: now,
        statusChangedBy: adminUserId,
        graceDeadline: null,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId.toString()))
      .run();
  }

  async reactivate(tenantId: TenantId, adminUserId: string): Promise<void> {
    const now = Date.now();

    this.db
      .update(tenantStatus)
      .set({
        status: "active",
        statusReason: null,
        statusChangedAt: now,
        statusChangedBy: adminUserId,
        graceDeadline: null,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId.toString()))
      .run();
  }

  async ban(tenantId: TenantId, reason: string, adminUserId: string): Promise<void> {
    const now = Date.now();
    await this.ensureExists(tenantId);

    this.db
      .update(tenantStatus)
      .set({
        status: "banned",
        statusReason: reason,
        statusChangedAt: now,
        statusChangedBy: adminUserId,
        graceDeadline: null,
        dataDeleteAfter: sql`(datetime('now', '+${sql.raw(String(BAN_DELETE_DAYS))} days'))`,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId.toString()))
      .run();
  }

  async setGracePeriod(tenantId: TenantId): Promise<void> {
    const now = Date.now();
    await this.ensureExists(tenantId);

    this.db
      .update(tenantStatus)
      .set({
        status: "grace_period",
        statusChangedAt: now,
        graceDeadline: sql`(datetime('now', '+${sql.raw(String(GRACE_PERIOD_DAYS))} days'))`,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId.toString()))
      .run();
  }

  async expireGracePeriods(): Promise<string[]> {
    const expired = this.db
      .select({ tenantId: tenantStatus.tenantId })
      .from(tenantStatus)
      .where(sql`${tenantStatus.status} = 'grace_period' AND ${tenantStatus.graceDeadline} <= datetime('now')`)
      .all();

    const now = Date.now();
    for (const row of expired) {
      this.db
        .update(tenantStatus)
        .set({
          status: "suspended",
          statusReason: "Grace period expired",
          statusChangedAt: now,
          statusChangedBy: "system",
          graceDeadline: null,
          updatedAt: now,
        })
        .where(eq(tenantStatus.tenantId, row.tenantId))
        .run();
    }

    return expired.map((r) => r.tenantId);
  }

  async isOperational(tenantId: TenantId): Promise<boolean> {
    const status = await this.getStatus(tenantId);
    return status === "active" || status === "grace_period";
  }
}
