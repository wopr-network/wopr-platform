import crypto from "node:crypto";
import type { IAdminAuditLogRepository } from "./admin-audit-log-repository.js";

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
  outcome?: "success" | "failure";
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
  outcome: string | null;
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

export class AdminAuditLog {
  private repo: IAdminAuditLogRepository;

  constructor(repo: IAdminAuditLogRepository) {
    this.repo = repo;
  }

  /** Append an audit entry. Immutable -- no updates or deletes. */
  async log(entry: AuditEntry): Promise<AdminAuditLogRow> {
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
      outcome: entry.outcome ?? null,
    };

    try {
      await this.repo.insert(row);
    } catch {
      // Audit log failures are non-fatal — swallow to prevent unhandled rejections
      // when the database is unavailable or closing (e.g. in tests).
    }

    return row;
  }

  /** Query audit log with filters. */
  async query(filters: AuditFilters): Promise<{ entries: AdminAuditLogRow[]; total: number }> {
    return this.repo.query(filters);
  }

  /** Export as CSV string for compliance. */
  async exportCsv(filters: AuditFilters): Promise<string> {
    const exportFilters = { ...filters, limit: undefined, offset: undefined };
    const rows = await this.repo.queryAll(exportFilters);

    const header =
      "id,admin_user,action,category,target_tenant,target_user,details,ip_address,user_agent,created_at,outcome";
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
        csvEscape(r.outcome ?? ""),
      ];
      return fields.join(",");
    });

    return [header, ...lines].join("\n");
  }
}
