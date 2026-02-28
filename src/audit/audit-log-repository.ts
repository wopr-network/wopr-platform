import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, gte, like, lt, lte, max, min } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import type { AuditQueryFilters } from "./query.js";
import type { AuditEntry } from "./schema.js";

/** Repository interface for user-facing audit log operations. */
export interface IAuditLogRepository {
  /** Insert a new audit entry. */
  insert(entry: AuditEntry): Promise<void>;
  /** Query entries with filters. Returns matching entries. */
  query(filters: AuditQueryFilters): Promise<AuditEntry[]>;
  /** Count entries matching filters. */
  count(filters: Omit<AuditQueryFilters, "limit" | "offset">): Promise<number>;
  /** Delete entries older than cutoff timestamp. Returns number deleted. */
  purgeOlderThan(cutoffTimestamp: number): Promise<number>;
  /** Delete entries for a specific user older than cutoff timestamp. Returns number deleted. */
  purgeOlderThanForUser(cutoffTimestamp: number, userId: string): Promise<number>;
  /** Count entries grouped by action. */
  countByAction(filters: { since?: number; until?: number }): Promise<Record<string, number>>;
  /** Get the oldest and newest timestamps for entries matching filters. */
  getTimeRange(filters: { since?: number; until?: number }): Promise<{ oldest: string | null; newest: string | null }>;
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

  async insert(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
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
    });
  }

  async query(filters: AuditQueryFilters): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);
    const where = buildConditions(filters);

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset(offset);

    return rows.map(toEntry);
  }

  async count(filters: Omit<AuditQueryFilters, "limit" | "offset">): Promise<number> {
    const where = buildConditions(filters);
    const result = (await this.db.select({ count: count() }).from(auditLog).where(where))[0];
    return result?.count ?? 0;
  }

  async purgeOlderThan(cutoffTimestamp: number): Promise<number> {
    const result = await this.db
      .delete(auditLog)
      .where(lt(auditLog.timestamp, cutoffTimestamp))
      .returning({ id: auditLog.id });
    return result.length;
  }

  async purgeOlderThanForUser(cutoffTimestamp: number, userId: string): Promise<number> {
    const result = await this.db
      .delete(auditLog)
      .where(and(eq(auditLog.userId, userId), lt(auditLog.timestamp, cutoffTimestamp)))
      .returning({ id: auditLog.id });
    return result.length;
  }

  async countByAction(filters: { since?: number; until?: number }): Promise<Record<string, number>> {
    const conditions: SQL[] = [];
    if (filters.since != null) conditions.push(gte(auditLog.timestamp, filters.since));
    if (filters.until != null) conditions.push(lte(auditLog.timestamp, filters.until));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select({ action: auditLog.action, count: count() })
      .from(auditLog)
      .where(where)
      .groupBy(auditLog.action);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.action] = row.count;
    }
    return result;
  }

  async getTimeRange(filters: {
    since?: number;
    until?: number;
  }): Promise<{ oldest: string | null; newest: string | null }> {
    const conditions: SQL[] = [];
    if (filters.since != null) conditions.push(gte(auditLog.timestamp, filters.since));
    if (filters.until != null) conditions.push(lte(auditLog.timestamp, filters.until));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select({ oldest: min(auditLog.timestamp), newest: max(auditLog.timestamp) })
      .from(auditLog)
      .where(where);

    const row = rows[0];
    return {
      oldest: row?.oldest != null ? new Date(row.oldest).toISOString() : null,
      newest: row?.newest != null ? new Date(row.newest).toISOString() : null,
    };
  }
}
