import { and, asc, count, desc, eq, gt, lt, or, type SQL, sql } from "drizzle-orm";
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AdminUserStore {
  constructor(private readonly db: DrizzleDb) {}

  /** List users with pagination, filtering, and sorting. */
  list(filters: AdminUserFilters = {}): AdminUserListResponse {
    const conditions: SQL[] = [];

    if (filters.search) {
      // raw SQL: Drizzle's like() has no ESCAPE clause support; ESCAPE '\\' is required
      // for correct wildcard escaping when the search term contains %, _, or \
      const pattern = `%${escapeLike(filters.search)}%`;
      conditions.push(
        or(
          sql`${adminUsers.name} LIKE ${pattern} ESCAPE '\\'`,
          sql`${adminUsers.email} LIKE ${pattern} ESCAPE '\\'`,
          sql`${adminUsers.tenantId} LIKE ${pattern} ESCAPE '\\'`,
        ) as SQL,
      );
    }

    if (filters.status) {
      conditions.push(eq(adminUsers.status, filters.status));
    }

    if (filters.role) {
      conditions.push(eq(adminUsers.role, filters.role));
    }

    if (filters.hasCredits === true) {
      conditions.push(gt(adminUsers.creditBalanceCents, 0));
    } else if (filters.hasCredits === false) {
      conditions.push(eq(adminUsers.creditBalanceCents, 0));
    }

    if (filters.lowBalance === true) {
      conditions.push(lt(adminUsers.creditBalanceCents, 500));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const sortCol = SORT_COLUMN_MAP[filters.sortBy ?? "created_at"];
    const orderExpr = filters.sortOrder === "asc" ? asc(sortCol) : desc(sortCol);

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const [{ total }] = this.db.select({ total: count() }).from(adminUsers).where(where).all();

    const rows = this.db.select().from(adminUsers).where(where).orderBy(orderExpr).limit(limit).offset(offset).all();

    return { users: rows.map(toSummary), total, limit, offset };
  }

  /** Full-text search across name, email, and tenant_id. */
  search(query: string): AdminUserSummary[] {
    // raw SQL: Drizzle's like() has no ESCAPE clause support
    const pattern = `%${escapeLike(query)}%`;
    return this.db
      .select()
      .from(adminUsers)
      .where(
        or(
          sql`${adminUsers.name} LIKE ${pattern} ESCAPE '\\'`,
          sql`${adminUsers.email} LIKE ${pattern} ESCAPE '\\'`,
          sql`${adminUsers.tenantId} LIKE ${pattern} ESCAPE '\\'`,
        ),
      )
      .orderBy(desc(adminUsers.createdAt))
      .limit(50)
      .all()
      .map(toSummary);
  }

  /** Get a single user by ID. */
  getById(userId: string): AdminUserSummary | null {
    const row = this.db.select().from(adminUsers).where(eq(adminUsers.id, userId)).get();
    return row ? toSummary(row) : null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SORT_COLUMN_MAP = {
  last_seen: adminUsers.lastSeen,
  created_at: adminUsers.createdAt,
  balance: adminUsers.creditBalanceCents,
  agent_count: adminUsers.agentCount,
} as const;

/** Escape LIKE special characters for safe parameterized queries. */
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function toSummary(row: typeof adminUsers.$inferSelect): AdminUserSummary {
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
