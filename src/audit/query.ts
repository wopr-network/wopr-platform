import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, gte, like, lte } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
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

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 50;

/** Build Drizzle WHERE conditions from filters. */
function buildConditions(filters: Omit<AuditQueryFilters, "limit" | "offset">): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.userId) {
    conditions.push(eq(auditLog.userId, filters.userId));
  }

  if (filters.action) {
    if (filters.action.endsWith(".*")) {
      const prefix = filters.action.slice(0, -1); // "instance."
      conditions.push(like(auditLog.action, `${prefix}%`));
    } else {
      conditions.push(eq(auditLog.action, filters.action));
    }
  }

  if (filters.resourceType) {
    conditions.push(eq(auditLog.resourceType, filters.resourceType));
  }

  if (filters.resourceId) {
    conditions.push(eq(auditLog.resourceId, filters.resourceId));
  }

  if (filters.since != null) {
    conditions.push(gte(auditLog.timestamp, filters.since));
  }

  if (filters.until != null) {
    conditions.push(lte(auditLog.timestamp, filters.until));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Query audit log entries with optional filters. */
export function queryAuditLog(db: DrizzleDb, filters: AuditQueryFilters): AuditEntry[] {
  const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);
  const where = buildConditions(filters);

  const rows = db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.timestamp))
    .limit(limit)
    .offset(offset)
    .all();

  // Drizzle returns camelCase; map back to snake_case for AuditEntry compatibility
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    user_id: r.userId,
    auth_method: r.authMethod,
    action: r.action,
    resource_type: r.resourceType,
    resource_id: r.resourceId,
    details: r.details,
    ip_address: r.ipAddress,
    user_agent: r.userAgent,
  })) as AuditEntry[];
}

/** Count audit log entries matching optional filters. */
export function countAuditLog(db: DrizzleDb, filters: Omit<AuditQueryFilters, "limit" | "offset">): number {
  const where = buildConditions(filters);

  const result = db.select({ count: count() }).from(auditLog).where(where).get();

  return result?.count ?? 0;
}
