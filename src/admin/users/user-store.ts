import { and, asc, count, desc, eq, gt, ilike, lt, or } from "drizzle-orm";
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
  credit_balance_credits: number;
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
  async list(filters: AdminUserFilters = {}): Promise<AdminUserListResponse> {
    // Build Drizzle conditions array
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: ReturnType<typeof eq>[] = [];

    if (filters.search) {
      // raw SQL: Drizzle's like() has no ESCAPE clause support; ESCAPE '\\' is required
      // for correct wildcard escaping when the search term contains %, _, or \
      const pattern = `%${escapeLike(filters.search)}%`;
      conditions.push(
        or(
          ilike(adminUsers.name, pattern),
          ilike(adminUsers.email, pattern),
          ilike(adminUsers.tenantId, pattern),
        ) as ReturnType<typeof eq>,
      );
    }

    if (filters.status) {
      conditions.push(eq(adminUsers.status, filters.status));
    }

    if (filters.role) {
      conditions.push(eq(adminUsers.role, filters.role));
    }

    if (filters.hasCredits === true) {
      conditions.push(gt(adminUsers.creditBalanceCredits, 0));
    } else if (filters.hasCredits === false) {
      conditions.push(eq(adminUsers.creditBalanceCredits, 0));
    }

    if (filters.lowBalance === true) {
      conditions.push(lt(adminUsers.creditBalanceCredits, 500));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Count total matching rows
    const countRows = await this.db.select({ count: count() }).from(adminUsers).where(whereClause);
    const total = Number(countRows[0]?.count ?? 0);

    // Sort
    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    type SortableColumn =
      | typeof adminUsers.lastSeen
      | typeof adminUsers.createdAt
      | typeof adminUsers.creditBalanceCredits
      | typeof adminUsers.agentCount;

    const sortColumnMap: Record<string, SortableColumn> = {
      last_seen: adminUsers.lastSeen,
      created_at: adminUsers.createdAt,
      balance: adminUsers.creditBalanceCredits,
      agent_count: adminUsers.agentCount,
    };
    const sortCol = sortColumnMap[filters.sortBy ?? "created_at"] ?? adminUsers.createdAt;
    const orderFn = filters.sortOrder === "asc" ? asc : desc;

    const rows = await this.db
      .select()
      .from(adminUsers)
      .where(whereClause)
      .orderBy(orderFn(sortCol))
      .limit(limit)
      .offset(offset);

    const users: AdminUserSummary[] = rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      tenant_id: row.tenantId,
      status: row.status,
      role: row.role,
      credit_balance_credits: row.creditBalanceCredits,
      agent_count: row.agentCount,
      last_seen: row.lastSeen,
      created_at: row.createdAt,
    }));

    return { users, total, limit, offset };
  }

  /** Full-text search across name, email, and tenant_id. */
  async search(query: string): Promise<AdminUserSummary[]> {
    const pattern = `%${escapeLike(query)}%`;
    const rows = await this.db
      .select()
      .from(adminUsers)
      .where(or(ilike(adminUsers.name, pattern), ilike(adminUsers.email, pattern), ilike(adminUsers.tenantId, pattern)))
      .orderBy(desc(adminUsers.createdAt))
      .limit(50);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      tenant_id: row.tenantId,
      status: row.status,
      role: row.role,
      credit_balance_credits: row.creditBalanceCredits,
      agent_count: row.agentCount,
      last_seen: row.lastSeen,
      created_at: row.createdAt,
    }));
  }

  /** Get a single user by ID. */
  async getById(userId: string): Promise<AdminUserSummary | null> {
    const rows = await this.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      tenant_id: row.tenantId,
      status: row.status,
      role: row.role,
      credit_balance_credits: row.creditBalanceCredits,
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
