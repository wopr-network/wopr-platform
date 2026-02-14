import crypto from "node:crypto";
import type Database from "better-sqlite3";

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

export class AdminAuditLog {
  private insertStmt: Database.Statement;
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO admin_audit_log (id, admin_user, action, category, target_tenant, target_user, details, ip_address, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
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

    this.insertStmt.run(
      row.id,
      row.admin_user,
      row.action,
      row.category,
      row.target_tenant,
      row.target_user,
      row.details,
      row.ip_address,
      row.user_agent,
      row.created_at,
    );

    return row;
  }

  /** Query audit log with filters. */
  query(filters: AuditFilters): { entries: AdminAuditLogRow[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.admin) {
      conditions.push("admin_user = ?");
      params.push(filters.admin);
    }

    if (filters.action) {
      conditions.push("action = ?");
      params.push(filters.action);
    }

    if (filters.category) {
      conditions.push("category = ?");
      params.push(filters.category);
    }

    if (filters.tenant) {
      conditions.push("target_tenant = ?");
      params.push(filters.tenant);
    }

    if (filters.from != null) {
      conditions.push("created_at >= ?");
      params.push(filters.from);
    }

    if (filters.to != null) {
      conditions.push("created_at <= ?");
      params.push(filters.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countSql = `SELECT COUNT(*) as count FROM admin_audit_log ${where}`;
    const countRow = this.db.prepare(countSql).get(...params) as { count: number };
    const total = countRow.count;

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const sql = `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const entries = this.db.prepare(sql).all(...params, limit, offset) as AdminAuditLogRow[];

    return { entries, total };
  }

  /** Export as CSV string for compliance. */
  exportCsv(filters: AuditFilters): string {
    // For CSV export, remove pagination limits
    const exportFilters = { ...filters, limit: undefined, offset: undefined };
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (exportFilters.admin) {
      conditions.push("admin_user = ?");
      params.push(exportFilters.admin);
    }

    if (exportFilters.action) {
      conditions.push("action = ?");
      params.push(exportFilters.action);
    }

    if (exportFilters.category) {
      conditions.push("category = ?");
      params.push(exportFilters.category);
    }

    if (exportFilters.tenant) {
      conditions.push("target_tenant = ?");
      params.push(exportFilters.tenant);
    }

    if (exportFilters.from != null) {
      conditions.push("created_at >= ?");
      params.push(exportFilters.from);
    }

    if (exportFilters.to != null) {
      conditions.push("created_at <= ?");
      params.push(exportFilters.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as AdminAuditLogRow[];

    const header = "id,admin_user,action,category,target_tenant,target_user,details,ip_address,user_agent,created_at";
    const lines = rows.map((r) => {
      const fields = [
        r.id,
        r.admin_user,
        r.action,
        r.category,
        r.target_tenant ?? "",
        r.target_user ?? "",
        `"${r.details.replace(/"/g, '""')}"`,
        r.ip_address ?? "",
        r.user_agent ?? "",
        String(r.created_at),
      ];
      return fields.join(",");
    });

    return [header, ...lines].join("\n");
  }
}
