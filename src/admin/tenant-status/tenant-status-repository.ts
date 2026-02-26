import type { TenantAccountStatus, TenantStatusRecord } from "../admin-repository-types.js";

export type { TenantAccountStatus, TenantStatusRecord };

export interface ITenantStatusRepository {
  get(tenantId: string): Promise<TenantStatusRecord | null>;
  getStatus(tenantId: string): Promise<TenantAccountStatus>;
  ensureExists(tenantId: string): Promise<void>;
  suspend(tenantId: string, reason: string, adminUserId: string): Promise<void>;
  reactivate(tenantId: string, adminUserId: string): Promise<void>;
  ban(tenantId: string, reason: string, adminUserId: string): Promise<void>;
  setGracePeriod(tenantId: string): Promise<void>;
  expireGracePeriods(): Promise<string[]>;
  isOperational(tenantId: string): Promise<boolean>;
}
