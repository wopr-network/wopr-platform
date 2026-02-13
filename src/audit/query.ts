import type Database from "better-sqlite3";
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

/** Query audit log entries with optional filters. */
export function queryAuditLog(db: Database.Database, filters: AuditQueryFilters): AuditEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.userId) {
    conditions.push("user_id = ?");
    params.push(filters.userId);
  }

  if (filters.action) {
    if (filters.action.endsWith(".*")) {
      // Wildcard match: "instance.*" matches "instance.create", "instance.destroy", etc.
      const prefix = filters.action.slice(0, -1); // "instance."
      conditions.push("action LIKE ?");
      params.push(`${prefix}%`);
    } else {
      conditions.push("action = ?");
      params.push(filters.action);
    }
  }

  if (filters.resourceType) {
    conditions.push("resource_type = ?");
    params.push(filters.resourceType);
  }

  if (filters.resourceId) {
    conditions.push("resource_id = ?");
    params.push(filters.resourceId);
  }

  if (filters.since != null) {
    conditions.push("timestamp >= ?");
    params.push(filters.since);
  }

  if (filters.until != null) {
    conditions.push("timestamp <= ?");
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);

  const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params) as AuditEntry[];
}

/** Count audit log entries matching optional filters. */
export function countAuditLog(db: Database.Database, filters: Omit<AuditQueryFilters, "limit" | "offset">): number {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.userId) {
    conditions.push("user_id = ?");
    params.push(filters.userId);
  }

  if (filters.action) {
    if (filters.action.endsWith(".*")) {
      const prefix = filters.action.slice(0, -1);
      conditions.push("action LIKE ?");
      params.push(`${prefix}%`);
    } else {
      conditions.push("action = ?");
      params.push(filters.action);
    }
  }

  if (filters.resourceType) {
    conditions.push("resource_type = ?");
    params.push(filters.resourceType);
  }

  if (filters.resourceId) {
    conditions.push("resource_id = ?");
    params.push(filters.resourceId);
  }

  if (filters.since != null) {
    conditions.push("timestamp >= ?");
    params.push(filters.since);
  }

  if (filters.until != null) {
    conditions.push("timestamp <= ?");
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT COUNT(*) as count FROM audit_log ${where}`;

  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}
