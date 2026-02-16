import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/admin-users.js";
import type {
  AdminUserFilters,
  AdminUserListResponse,
  AdminUserRepository,
  AdminUserSummary,
} from "../../domain/repositories/admin-user-repository.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export class DrizzleAdminUserRepository implements AdminUserRepository {
  constructor(private readonly db: DrizzleDb) {}

  async list(filters: AdminUserFilters = {}): Promise<AdminUserListResponse> {
    const conditions = [];

    if (filters.search) {
      const pattern = `%${escapeLike(filters.search)}%`;
      conditions.push(
        sql`(${like(adminUsers.name, pattern)} OR ${like(adminUsers.email, pattern)} OR ${like(adminUsers.tenantId, pattern)})`,
      );
    }

    if (filters.status) {
      conditions.push(eq(adminUsers.status, filters.status));
    }

    if (filters.role) {
      conditions.push(eq(adminUsers.role, filters.role));
    }

    if (filters.hasCredits === true) {
      conditions.push(sql`${adminUsers.creditBalanceCents} > 0`);
    } else if (filters.hasCredits === false) {
      conditions.push(eq(adminUsers.creditBalanceCents, 0));
    }

    if (filters.lowBalance === true) {
      conditions.push(sql`${adminUsers.creditBalanceCents} < 500`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const totalResult = await this.db
      .select({ count: sql<number>`count(*)`.as("count") })
      .from(adminUsers)
      .where(whereClause);
    const total = totalResult[0]?.count ?? 0;

    const sortCol = filters.sortBy ?? "created_at";
    const orderByClause =
      sortCol === "last_seen"
        ? filters.sortOrder === "asc"
          ? asc(adminUsers.lastSeen)
          : desc(adminUsers.lastSeen)
        : filters.sortOrder === "asc"
          ? asc(adminUsers.createdAt)
          : desc(adminUsers.createdAt);

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const rows = await this.db
      .select()
      .from(adminUsers)
      .where(whereClause)
      .orderBy(orderByClause)
      .limit(limit)
      .offset(offset);

    const users: AdminUserSummary[] = rows.map(mapRowToAdminUserSummary);

    return { users, total, limit, offset };
  }

  async search(query: string): Promise<AdminUserSummary[]> {
    const pattern = `%${escapeLike(query)}%`;
    const rows = await this.db
      .select()
      .from(adminUsers)
      .where(
        sql`(${like(adminUsers.name, pattern)} OR ${like(adminUsers.email, pattern)} OR ${like(adminUsers.tenantId, pattern)})`,
      )
      .orderBy(desc(adminUsers.createdAt))
      .limit(50);

    return rows.map(mapRowToAdminUserSummary);
  }

  async getById(userId: string): Promise<AdminUserSummary | null> {
    const row = await this.db.select().from(adminUsers).where(eq(adminUsers.id, userId)).limit(1);
    return row[0] ? mapRowToAdminUserSummary(row[0]) : null;
  }
}

function mapRowToAdminUserSummary(row: typeof adminUsers.$inferSelect): AdminUserSummary {
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

function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
