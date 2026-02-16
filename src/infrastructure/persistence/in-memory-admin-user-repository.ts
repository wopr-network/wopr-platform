import type {
  AdminUserFilters,
  AdminUserListResponse,
  AdminUserRepository,
  AdminUserSummary,
} from "../../domain/repositories/admin-user-repository.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export class InMemoryAdminUserRepository implements AdminUserRepository {
  private readonly users = new Map<string, AdminUserSummary>();

  constructor(initialUsers: AdminUserSummary[] = []) {
    for (const user of initialUsers) {
      this.users.set(user.id, user);
    }
  }

  async list(filters: AdminUserFilters = {}): Promise<AdminUserListResponse> {
    let results = Array.from(this.users.values());

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      results = results.filter(
        (u) =>
          u.name?.toLowerCase().includes(searchLower) ||
          u.email.toLowerCase().includes(searchLower) ||
          u.tenant_id.toLowerCase().includes(searchLower),
      );
    }

    if (filters.status) {
      results = results.filter((u) => u.status === filters.status);
    }

    if (filters.role) {
      results = results.filter((u) => u.role === filters.role);
    }

    if (filters.hasCredits === true) {
      results = results.filter((u) => u.credit_balance_cents > 0);
    } else if (filters.hasCredits === false) {
      results = results.filter((u) => u.credit_balance_cents === 0);
    }

    if (filters.lowBalance === true) {
      results = results.filter((u) => u.credit_balance_cents < 500);
    }

    const total = results.length;

    const sortBy = filters.sortBy ?? "created_at";
    const sortOrder = filters.sortOrder ?? "desc";
    const sortMultiplier = sortOrder === "asc" ? 1 : -1;

    results.sort((a, b) => {
      const aVal = a[sortBy as keyof AdminUserSummary];
      const bVal = b[sortBy as keyof AdminUserSummary];
      if (aVal === null || aVal === undefined) return sortMultiplier;
      if (bVal === null || bVal === undefined) return -sortMultiplier;
      if (typeof aVal === "number" && typeof bVal === "number") {
        return (aVal - bVal) * sortMultiplier;
      }
      return String(aVal).localeCompare(String(bVal)) * sortMultiplier;
    });

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);
    const paginated = results.slice(offset, offset + limit);

    return { users: paginated, total, limit, offset };
  }

  async search(query: string): Promise<AdminUserSummary[]> {
    const queryLower = query.toLowerCase();
    const results = Array.from(this.users.values()).filter(
      (u) =>
        u.name?.toLowerCase().includes(queryLower) ||
        u.email.toLowerCase().includes(queryLower) ||
        u.tenant_id.toLowerCase().includes(queryLower),
    );
    return results.slice(0, 50);
  }

  async getById(userId: string): Promise<AdminUserSummary | null> {
    return this.users.get(userId) ?? null;
  }

  addUser(user: AdminUserSummary): void {
    this.users.set(user.id, user);
  }

  reset(): void {
    this.users.clear();
  }
}
