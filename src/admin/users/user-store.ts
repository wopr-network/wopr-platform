import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminUserFilters {
  search?: string;
  status?: "active" | "suspended" | "grace_period" | "dormant";
  role?: "platform_admin" | "tenant_admin" | "user";
  hasCredits?: boolean;
  lowBalance?: boolean;
  sortBy?: "last_seen" | "created_at" | "balance" | "agent_count";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  tenant_id: string;
  status: string;
  role: string;
  credit_balance_cents: number;
  agent_count: number;
  last_seen: number | null;
  created_at: number;
}

export interface AdminUserListResponse {
  users: AdminUserSummary[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const VALID_SORT_COLUMNS: Record<string, string> = {
  last_seen: "last_seen",
  created_at: "created_at",
  balance: "credit_balance_cents",
  agent_count: "agent_count",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AdminUserStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** List users with pagination, filtering, and sorting. */
  list(filters: AdminUserFilters = {}): AdminUserListResponse {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.search) {
      const pattern = `%${escapeLike(filters.search)}%`;
      conditions.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR tenant_id LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }

    if (filters.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }

    if (filters.role) {
      conditions.push("role = ?");
      params.push(filters.role);
    }

    if (filters.hasCredits) {
      conditions.push("credit_balance_cents > 0");
    }

    if (filters.lowBalance) {
      conditions.push("credit_balance_cents < 500");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total matching rows
    const countSql = `SELECT COUNT(*) as count FROM admin_users ${where}`;
    const countRow = this.db.prepare(countSql).get(...params) as { count: number };
    const total = countRow.count;

    // Sort
    const sortCol = VALID_SORT_COLUMNS[filters.sortBy ?? "created_at"] ?? "created_at";
    const sortDir = filters.sortOrder === "asc" ? "ASC" : "DESC";
    const orderBy = `ORDER BY ${sortCol} ${sortDir}`;

    // Pagination
    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const sql = `SELECT * FROM admin_users ${where} ${orderBy} LIMIT ? OFFSET ?`;
    const users = this.db.prepare(sql).all(...params, limit, offset) as AdminUserSummary[];

    return { users, total, limit, offset };
  }

  /** Full-text search across name, email, and tenant_id. */
  search(query: string): AdminUserSummary[] {
    const pattern = `%${escapeLike(query)}%`;
    const sql = `
      SELECT * FROM admin_users
      WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR tenant_id LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return this.db.prepare(sql).all(pattern, pattern, pattern) as AdminUserSummary[];
  }

  /** Get a single user by ID. */
  getById(userId: string): AdminUserSummary | null {
    const sql = "SELECT * FROM admin_users WHERE id = ?";
    const row = this.db.prepare(sql).get(userId) as AdminUserSummary | undefined;
    return row ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE special characters for safe parameterized queries. */
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
