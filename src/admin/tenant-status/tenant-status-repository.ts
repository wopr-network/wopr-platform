import type { TenantAccountStatus, TenantStatusRecord } from "../admin-repository-types.js";

export type { TenantAccountStatus, TenantStatusRecord };

export interface ITenantStatusRepository {
  get(tenantId: string): TenantStatusRecord | null;
  getStatus(tenantId: string): TenantAccountStatus;
  ensureExists(tenantId: string): void;
  suspend(tenantId: string, reason: string, adminUserId: string): void;
  reactivate(tenantId: string, adminUserId: string): void;
  ban(tenantId: string, reason: string, adminUserId: string): void;
  setGracePeriod(tenantId: string): void;
  expireGracePeriods(): string[];
  isOperational(tenantId: string): boolean;
}
