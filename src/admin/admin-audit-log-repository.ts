import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { adminAuditLog } from "../db/schema/index.js";
import type { AdminAuditLogRow, AuditFilters } from "./audit-log.js";

/** Repository interface for admin audit log operations. */
export interface IAdminAuditLogRepository {
  /** Insert a new admin audit entry. */
  insert(row: AdminAuditLogRow): void;
  /** Query entries with filters. Returns matching entries and total count. */
  query(filters: AuditFilters): { entries: AdminAuditLogRow[]; total: number };
  /** Query all entries matching filters (no pagination). For CSV export. */
  queryAll(filters: Omit<AuditFilters, "limit" | "offset">): AdminAuditLogRow[];
}

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 50;

/** Build Drizzle WHERE conditions from filters. */
function buildConditions(filters: Omit<AuditFilters, "limit" | "offset">): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.admin) {
    conditions.push(eq(adminAuditLog.adminUser, filters.admin));
  }

  if (filters.action) {
    conditions.push(eq(adminAuditLog.action, filters.action));
  }

  if (filters.category) {
    conditions.push(eq(adminAuditLog.category, filters.category));
  }

  if (filters.tenant) {
    conditions.push(eq(adminAuditLog.targetTenant, filters.tenant));
  }

  if (filters.from != null) {
    conditions.push(gte(adminAuditLog.createdAt, filters.from));
  }

  if (filters.to != null) {
    conditions.push(lte(adminAuditLog.createdAt, filters.to));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Map a Drizzle row to a snake_case AdminAuditLogRow. */
function toRow(r: typeof adminAuditLog.$inferSelect): AdminAuditLogRow {
  return {
    id: r.id,
    admin_user: r.adminUser,
    action: r.action,
    category: r.category,
    target_tenant: r.targetTenant,
    target_user: r.targetUser,
    details: r.details,
    ip_address: r.ipAddress,
    user_agent: r.userAgent,
    created_at: r.createdAt,
    outcome: r.outcome ?? null,
  };
}

export class DrizzleAdminAuditLogRepository implements IAdminAuditLogRepository {
  constructor(private readonly db: DrizzleDb) {}

  insert(row: AdminAuditLogRow): void {
    this.db
      .insert(adminAuditLog)
      .values({
        id: row.id,
        adminUser: row.admin_user,
        action: row.action,
        category: row.category,
        targetTenant: row.target_tenant,
        targetUser: row.target_user,
        details: row.details,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        outcome: row.outcome,
      })
      .run();
  }

  query(filters: AuditFilters): { entries: AdminAuditLogRow[]; total: number } {
    const where = buildConditions(filters);

    const countResult = this.db.select({ count: count() }).from(adminAuditLog).where(where).get();
    const total = countResult?.count ?? 0;

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const rows = this.db
      .select()
      .from(adminAuditLog)
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    return { entries: rows.map(toRow), total };
  }

  queryAll(filters: Omit<AuditFilters, "limit" | "offset">): AdminAuditLogRow[] {
    const where = buildConditions(filters);

    const rows = this.db.select().from(adminAuditLog).where(where).orderBy(desc(adminAuditLog.createdAt)).all();

    return rows.map(toRow);
  }
}
