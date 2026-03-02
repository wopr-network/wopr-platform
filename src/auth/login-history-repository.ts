import type { Pool } from "pg";

export interface LoginHistoryEntry {
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ILoginHistoryRepository {
  findByUserId(userId: string, limit?: number): Promise<LoginHistoryEntry[]>;
}

export class BetterAuthLoginHistoryRepository implements ILoginHistoryRepository {
  constructor(private readonly pool: Pool) {}

  async findByUserId(userId: string, limit = 20): Promise<LoginHistoryEntry[]> {
    // raw SQL: better-auth manages its own schema outside Drizzle
    const { rows } = await this.pool.query(
      `SELECT "ipAddress", "userAgent", "createdAt" FROM "session" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT $2`,
      [userId, Math.min(Math.max(1, limit), 100)],
    );
    return rows.map((r: { ipAddress: string | null; userAgent: string | null; createdAt: Date }) => ({
      ip: r.ipAddress,
      userAgent: r.userAgent,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  }
}
