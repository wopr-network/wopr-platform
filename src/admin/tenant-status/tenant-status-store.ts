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
  get(tenantId: string): TenantStatusRecord | null {
    const row = this.db.select().from(tenantStatus).where(eq(tenantStatus.tenantId, tenantId)).get();
    return (row as TenantStatusRecord) ?? null;
  }

  /** Get the account status string for a tenant. Defaults to 'active' if no row exists. */
  getStatus(tenantId: string): TenantAccountStatus {
    const row = this.get(tenantId);
    return (row?.status as TenantAccountStatus) ?? "active";
  }

  /** Ensure a tenant has a status row (upsert). */
  ensureExists(tenantId: string): void {
    this.db.insert(tenantStatus).values({ tenantId, status: "active" }).onConflictDoNothing().run();
  }

  /**
   * Suspend a tenant account.
   *
   * Transitions from active or grace_period to suspended.
   * Requires a reason and the admin user ID performing the action.
   */
  suspend(tenantId: string, reason: string, adminUserId: string): void {
    const now = Date.now();
    this.ensureExists(tenantId);

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
      .where(eq(tenantStatus.tenantId, tenantId))
      .run();
  }

  /**
   * Reactivate a suspended tenant account.
   *
   * Transitions from suspended to active.
   * Clears the suspension reason and deadlines.
   */
  reactivate(tenantId: string, adminUserId: string): void {
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
      .where(eq(tenantStatus.tenantId, tenantId))
      .run();
  }

  /**
   * Ban a tenant account permanently.
   *
   * Transitions to banned. Sets data deletion deadline to 30 days from now.
   * Requires a reason and TOS reference.
   */
  ban(tenantId: string, reason: string, adminUserId: string): void {
    const now = Date.now();
    this.ensureExists(tenantId);

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
      .where(eq(tenantStatus.tenantId, tenantId))
      .run();
  }

  /**
   * Set a tenant to grace period.
   *
   * Sets the grace deadline to 3 days from now.
   */
  setGracePeriod(tenantId: string): void {
    const now = Date.now();
    this.ensureExists(tenantId);

    this.db
      .update(tenantStatus)
      .set({
        status: "grace_period",
        statusChangedAt: now,
        graceDeadline: sql`(datetime('now', '+${sql.raw(String(GRACE_PERIOD_DAYS))} days'))`,
        updatedAt: now,
      })
      .where(eq(tenantStatus.tenantId, tenantId))
      .run();
  }

  /**
   * Auto-suspend tenants whose grace period has expired.
   *
   * Returns the IDs of tenants that were suspended.
   */
  expireGracePeriods(): string[] {
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

  /**
   * Check if a tenant's account is operational (active or grace_period).
   *
   * Returns true if the tenant can perform operations.
   */
  isOperational(tenantId: string): boolean {
    const status = this.getStatus(tenantId);
    return status === "active" || status === "grace_period";
  }
}
