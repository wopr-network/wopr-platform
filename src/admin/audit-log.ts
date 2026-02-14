import crypto from "node:crypto";
import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { adminAuditLog } from "../db/schema/index.js";

export type AuditCategory = "account" | "credits" | "roles" | "config" | "support" | "bulk";

export interface AuditEntry {
  adminUser: string;
  action: string;
  category: AuditCategory;
  targetTenant?: string;
  targetUser?: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface AdminAuditLogRow {
  id: string;
  admin_user: string;
  action: string;
  category: string;
  target_tenant: string | null;
  target_user: string | null;
  details: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface AuditFilters {
  admin?: string;
  action?: string;
  category?: string;
  tenant?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
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
  };
}

export class AdminAuditLog {
  private db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  /** Append an audit entry. Immutable -- no updates or deletes. */
  log(entry: AuditEntry): AdminAuditLogRow {
    const row: AdminAuditLogRow = {
      id: crypto.randomUUID(),
      admin_user: entry.adminUser,
      action: entry.action,
      category: entry.category,
      target_tenant: entry.targetTenant ?? null,
      target_user: entry.targetUser ?? null,
      details: JSON.stringify(entry.details),
      ip_address: entry.ipAddress ?? null,
      user_agent: entry.userAgent ?? null,
      created_at: Date.now(),
    };

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
      })
      .run();

    return row;
  }

  /** Query audit log with filters. */
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

  /** Export as CSV string for compliance. */
  exportCsv(filters: AuditFilters): string {
    const exportFilters = { ...filters, limit: undefined, offset: undefined };
    const where = buildConditions(exportFilters);

    const rows = this.db
      .select()
      .from(adminAuditLog)
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt))
      .all()
      .map(toRow);

    const header = "id,admin_user,action,category,target_tenant,target_user,details,ip_address,user_agent,created_at";
    const csvEscape = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = rows.map((r) => {
      const fields = [
        csvEscape(r.id),
        csvEscape(r.admin_user),
        csvEscape(r.action),
        csvEscape(r.category),
        csvEscape(r.target_tenant ?? ""),
        csvEscape(r.target_user ?? ""),
        csvEscape(r.details),
        csvEscape(r.ip_address ?? ""),
        csvEscape(r.user_agent ?? ""),
        String(r.created_at),
      ];
      return fields.join(",");
    });

    return [header, ...lines].join("\n");
  }
}
