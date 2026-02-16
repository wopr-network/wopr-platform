/**
 * Repository Interface: TenantStatusRepository (ASYNC)
 *
 * Manages tenant account status transitions: active, grace_period, suspended, banned.
 */

import type { TenantAccountStatus, TenantStatus } from "../entities/tenant-status.js";
import type { TenantId } from "../value-objects/tenant-id.js";

export interface TenantStatusRepository {
  /**
   * Get the status row for a tenant. Returns null if not found.
   */
  get(tenantId: TenantId): Promise<TenantStatus | null>;

  /**
   * Get the account status string for a tenant. Defaults to 'active' if no row exists.
   */
  getStatus(tenantId: TenantId): Promise<TenantAccountStatus>;

  /**
   * Ensure a tenant has a status row (upsert).
   */
  ensureExists(tenantId: TenantId): Promise<void>;

  /**
   * Suspend a tenant account.
   * Transitions from active or grace_period to suspended.
   */
  suspend(tenantId: TenantId, reason: string, adminUserId: string): Promise<void>;

  /**
   * Reactivate a suspended tenant account.
   * Transitions from suspended to active.
   */
  reactivate(tenantId: TenantId, adminUserId: string): Promise<void>;

  /**
   * Ban a tenant account permanently.
   * Transitions to banned. Sets data deletion deadline.
   */
  ban(tenantId: TenantId, reason: string, adminUserId: string): Promise<void>;

  /**
   * Set a tenant to grace period.
   */
  setGracePeriod(tenantId: TenantId): Promise<void>;

  /**
   * Auto-suspend tenants whose grace period has expired.
   * Returns the IDs of tenants that were suspended.
   */
  expireGracePeriods(): Promise<string[]>;

  /**
   * Check if a tenant's account is operational (active or grace_period).
   */
  isOperational(tenantId: TenantId): Promise<boolean>;
}
