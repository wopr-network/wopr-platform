import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/index.js";

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
  constructor(private readonly db: DrizzleDb) {}

  /** List users with pagination, filtering, and sorting. */
  list(filters: AdminUserFilters = {}): AdminUserListResponse {
    // raw SQL: Drizzle cannot express dynamic ORDER BY with runtime column names from a
    // whitelist map, or LIKE with ESCAPE clauses for safe wildcard search across multiple columns
    const sqlite = this.db.$client;
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

    if (filters.hasCredits === true) {
      conditions.push("credit_balance_cents > 0");
    } else if (filters.hasCredits === false) {
      conditions.push("credit_balance_cents = 0");
    }

    if (filters.lowBalance === true) {
      conditions.push("credit_balance_cents < 500");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total matching rows
    const countSql = `SELECT COUNT(*) as count FROM admin_users ${where}`;
    const countRow = sqlite.prepare(countSql).get(...params) as { count: number };
    const total = countRow.count;

    // Sort
    const sortCol = VALID_SORT_COLUMNS[filters.sortBy ?? "created_at"] ?? "created_at";
    const sortDir = filters.sortOrder === "asc" ? "ASC" : "DESC";
    const orderBy = `ORDER BY ${sortCol} ${sortDir}`;

    // Pagination
    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const querySql = `SELECT * FROM admin_users ${where} ${orderBy} LIMIT ? OFFSET ?`;
    const users = sqlite.prepare(querySql).all(...params, limit, offset) as AdminUserSummary[];

    return { users, total, limit, offset };
  }

  /** Full-text search across name, email, and tenant_id. */
  search(query: string): AdminUserSummary[] {
    // raw SQL: Drizzle cannot express LIKE with ESCAPE clause for safe parameterized wildcard search
    const sqlite = this.db.$client;
    const pattern = `%${escapeLike(query)}%`;
    const querySql = `
      SELECT * FROM admin_users
      WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR tenant_id LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return sqlite.prepare(querySql).all(pattern, pattern, pattern) as AdminUserSummary[];
  }

  /** Get a single user by ID. */
  getById(userId: string): AdminUserSummary | null {
    const row = this.db.select().from(adminUsers).where(eq(adminUsers.id, userId)).get();
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      tenant_id: row.tenantId,
      status: row.status,
      role: row.role,
      credit_balance_cents: row.creditBalanceCents,
      agent_count: row.agentCount,
      last_seen: row.lastSeen,
      created_at: row.createdAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE special characters for safe parameterized queries. */
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
