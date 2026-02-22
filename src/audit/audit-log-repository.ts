import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, gte, like, lt, lte } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import type { AuditQueryFilters } from "./query.js";
import type { AuditEntry } from "./schema.js";

/** Repository interface for user-facing audit log operations. */
export interface IAuditLogRepository {
  /** Insert a new audit entry. */
  insert(entry: AuditEntry): void;
  /** Query entries with filters. Returns matching entries. */
  query(filters: AuditQueryFilters): AuditEntry[];
  /** Count entries matching filters. */
  count(filters: Omit<AuditQueryFilters, "limit" | "offset">): number;
  /** Delete entries older than cutoff timestamp. Returns number deleted. */
  purgeOlderThan(cutoffTimestamp: number): number;
  /** Delete entries for a specific user older than cutoff timestamp. Returns number deleted. */
  purgeOlderThanForUser(cutoffTimestamp: number, userId: string): number;
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

/** Map a Drizzle row to a snake_case AuditEntry. */
function toEntry(r: typeof auditLog.$inferSelect): AuditEntry {
  return {
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
  } as AuditEntry;
}

export class DrizzleAuditLogRepository implements IAuditLogRepository {
  constructor(private readonly db: DrizzleDb) {}

  insert(entry: AuditEntry): void {
    this.db
      .insert(auditLog)
      .values({
        id: entry.id,
        timestamp: entry.timestamp,
        userId: entry.user_id,
        authMethod: entry.auth_method,
        action: entry.action,
        resourceType: entry.resource_type,
        resourceId: entry.resource_id,
        details: entry.details,
        ipAddress: entry.ip_address,
        userAgent: entry.user_agent,
      })
      .run();
  }

  query(filters: AuditQueryFilters): AuditEntry[] {
    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);
    const where = buildConditions(filters);

    const rows = this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset(offset)
      .all();

    return rows.map(toEntry);
  }

  count(filters: Omit<AuditQueryFilters, "limit" | "offset">): number {
    const where = buildConditions(filters);
    const result = this.db.select({ count: count() }).from(auditLog).where(where).get();
    return result?.count ?? 0;
  }

  purgeOlderThan(cutoffTimestamp: number): number {
    const result = this.db.delete(auditLog).where(lt(auditLog.timestamp, cutoffTimestamp)).run();
    return result.changes;
  }

  purgeOlderThanForUser(cutoffTimestamp: number, userId: string): number {
    const result = this.db
      .delete(auditLog)
      .where(and(eq(auditLog.userId, userId), lt(auditLog.timestamp, cutoffTimestamp)))
      .run();
    return result.changes;
  }
}
