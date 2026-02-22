import type { IAuditLogRepository } from "./audit-log-repository.js";
import type { AuditEntry } from "./schema.js";

/** Filters for querying audit log entries. */
export interface AuditQueryFilters {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

/** Query audit log entries with optional filters. */
export function queryAuditLog(repo: IAuditLogRepository, filters: AuditQueryFilters): AuditEntry[] {
  return repo.query(filters);
}

/** Count audit log entries matching optional filters. */
export function countAuditLog(repo: IAuditLogRepository, filters: Omit<AuditQueryFilters, "limit" | "offset">): number {
  return repo.count(filters);
}
