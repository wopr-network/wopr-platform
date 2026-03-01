import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantStatus } from "../../db/schema/index.js";
import {
  BAN_DELETE_DAYS,
  GRACE_PERIOD_DAYS,
  type TenantAccountStatus,
  type TenantStatusRecord,
} from "../admin-repository-types.js";
import type { ITenantStatusRepository } from "./tenant-status-repository.js";

export type { TenantAccountStatus };

/** @deprecated Use TenantStatusRecord from admin-repository-types.js */
export type TenantStatusRow = TenantStatusRecord;

export { GRACE_PERIOD_DAYS, BAN_DELETE_DAYS };

/**
 * Tenant account status manager.
 *
 * Handles status transitions: active, grace_period, suspended, banned.
 * All state changes are atomic Drizzle operations.
 */
export class TenantStatusStore implements ITenantStatusRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Get the status row for a tenant. Returns null if not found. */
  async get(tenantId: string): Promise<TenantStatusRecord | null> {
    const rows = await this.db.select().from(tenantStatus).where(eq(tenantStatus.tenantId, tenantId));
    return (rows[0] as TenantStatusRecord) ?? null;
  }

  /** Get the account status string for a tenant. Defaults to 'active' if no row exists. */
  async getStatus(tenantId: string): Promise<TenantAccountStatus> {
    const row = await this.get(tenantId);
    return (row?.status as TenantAccountStatus) ?? "active";
  }

  /** Ensure a tenant has a status row (upsert). */
  async ensureExists(tenantId: string): Promise<void> {
    await this.db.insert(tenantStatus).values({ tenantId, status: "active" }).onConflictDoNothing();
  }

  /**
   * Suspend a tenant account.
   *
   * Transitions from active or grace_period to suspended.
   * Requires a reason and the admin user ID performing the action.
   */
  async suspend(tenantId: string, reason: string, adminUserId: string): Promise<void> {
    const now = Date.now();
    await this.ensureExists(tenantId);

    await this.db
      .update(tenantStatus)
      .set({
        status: "suspended",
        statusReason: reason,
        statusChangedAt: now,
        statusChangedBy: adminUserId,
        graceDeadline: null,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId));
  }

  /**
   * Reactivate a suspended tenant account.
   *
   * Transitions from suspended to active.
   * Clears the suspension reason and deadlines.
   */
  async reactivate(tenantId: string, adminUserId: string): Promise<void> {
    const now = Date.now();

    await this.db
      .update(tenantStatus)
      .set({
        status: "active",
        statusReason: null,
        statusChangedAt: now,
        statusChangedBy: adminUserId,
        graceDeadline: null,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId));
  }

  /**
   * Ban a tenant account permanently.
   *
   * Transitions to banned. Sets data deletion deadline to 30 days from now.
   * Requires a reason and TOS reference.
   */
  async ban(tenantId: string, reason: string, adminUserId: string): Promise<void> {
    const now = Date.now();
    await this.ensureExists(tenantId);

    await this.db
      .update(tenantStatus)
      .set({
        status: "banned",
        statusReason: reason,
        statusChangedAt: now,
        statusChangedBy: adminUserId,
        graceDeadline: null,
        dataDeleteAfter: sql`(now() + make_interval(days => ${BAN_DELETE_DAYS}))::text`,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId));
  }

  /**
   * Set a tenant to grace period.
   *
   * Sets the grace deadline to 3 days from now.
   */
  async setGracePeriod(tenantId: string): Promise<void> {
    const now = Date.now();
    await this.ensureExists(tenantId);

    await this.db
      .update(tenantStatus)
      .set({
        status: "grace_period",
        statusChangedAt: now,
        graceDeadline: sql`(now() + make_interval(days => ${GRACE_PERIOD_DAYS}))::text`,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId));
  }

  /**
   * Auto-suspend tenants whose grace period has expired.
   *
   * Returns the IDs of tenants that were suspended.
   */
  async expireGracePeriods(): Promise<string[]> {
    const expired = await this.db
      .select({ tenantId: tenantStatus.tenantId })
      .from(tenantStatus)
      .where(sql`${tenantStatus.status} = 'grace_period' AND ${tenantStatus.graceDeadline}::timestamptz <= now()`);

    const now = Date.now();
    for (const row of expired) {
      await this.db
        .update(tenantStatus)
        .set({
          status: "suspended",
          statusReason: "Grace period expired",
          statusChangedAt: now,
          statusChangedBy: "system",
          graceDeadline: null,
          updatedAt: now,
        })
        .where(eq(tenantStatus.tenantId, row.tenantId));
    }

    return expired.map((r) => r.tenantId);
  }

  /**
   * Check if a tenant's account is operational (active or grace_period).
   *
   * Returns true if the tenant can perform operations.
   */
  async isOperational(tenantId: string): Promise<boolean> {
    const status = await this.getStatus(tenantId);
    return status === "active" || status === "grace_period";
  }
}
