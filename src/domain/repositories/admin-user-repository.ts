/**
 * Repository Interface: AdminUserRepository (ASYNC)
 *
 * Manages admin user data for dashboard queries.
 */
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

export interface AdminUserRepository {
  /**
   * List users with pagination, filtering, and sorting.
   */
  list(filters?: AdminUserFilters): Promise<AdminUserListResponse>;

  /**
   * Full-text search across name, email, and tenant_id.
   */
  search(query: string): Promise<AdminUserSummary[]>;

  /**
   * Get a single user by ID.
   */
  getById(userId: string): Promise<AdminUserSummary | null>;
}
