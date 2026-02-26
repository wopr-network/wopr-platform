import { randomUUID } from "node:crypto";
import { and, eq, gt, sql, sum } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { sessionUsage } from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface SessionUsage {
  id: string;
  sessionId: string;
  userId: string | null;
  page: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  model: string;
  costUsd: number;
  createdAt: number;
}

export type NewSessionUsage = Omit<SessionUsage, "id" | "createdAt">;

export interface DailyCostAggregate {
  day: string;
  totalCostUsd: number;
  sessionCount: number;
}

export interface PageCostAggregate {
  page: string;
  totalCostUsd: number;
  callCount: number;
  avgCostUsd: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ISessionUsageRepository {
  insert(record: NewSessionUsage): Promise<SessionUsage>;
  findBySessionId(sessionId: string): Promise<SessionUsage[]>;
  sumCostByUser(userId: string, since: number): Promise<number>;
  sumCostBySession(sessionId: string): Promise<number>;
  aggregateByDay(since: number): Promise<DailyCostAggregate[]>;
  aggregateByPage(since: number): Promise<PageCostAggregate[]>;
  cacheHitRate(since: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

type DbRow = typeof sessionUsage.$inferSelect;

function toSessionUsage(row: DbRow): SessionUsage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    page: row.page,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    model: row.model,
    costUsd: row.costUsd,
    createdAt: row.createdAt,
  };
}

export class DrizzleSessionUsageRepository implements ISessionUsageRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(record: NewSessionUsage): Promise<SessionUsage> {
    const rows = await this.db
      .insert(sessionUsage)
      .values({
        id: randomUUID(),
        sessionId: record.sessionId,
        userId: record.userId ?? null,
        page: record.page ?? null,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cachedTokens: record.cachedTokens,
        cacheWriteTokens: record.cacheWriteTokens,
        model: record.model,
        costUsd: record.costUsd,
        createdAt: Date.now(),
      })
      .returning();
    return toSessionUsage(rows[0]);
  }

  async findBySessionId(sessionId: string): Promise<SessionUsage[]> {
    const rows = await this.db.select().from(sessionUsage).where(eq(sessionUsage.sessionId, sessionId));
    return rows.map(toSessionUsage);
  }

  async sumCostBySession(sessionId: string): Promise<number> {
    const result = await this.db
      .select({ total: sum(sessionUsage.costUsd) })
      .from(sessionUsage)
      .where(eq(sessionUsage.sessionId, sessionId));
    return Number(result[0]?.total ?? 0);
  }

  async sumCostByUser(userId: string, since: number): Promise<number> {
    const result = await this.db
      .select({ total: sum(sessionUsage.costUsd) })
      .from(sessionUsage)
      .where(and(eq(sessionUsage.userId, userId), gt(sessionUsage.createdAt, since)));
    return Number(result[0]?.total ?? 0);
  }

  async aggregateByDay(since: number): Promise<DailyCostAggregate[]> {
    const result = (await this.db.execute(sql`
      SELECT
        to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') as day,
        SUM(cost_usd) as total_cost_usd,
        COUNT(DISTINCT session_id) as session_count
      FROM session_usage
      WHERE created_at > ${since}
      GROUP BY day
      ORDER BY day DESC
    `)) as unknown as { rows: Array<{ day: string; total_cost_usd: string; session_count: string }> };
    return result.rows.map((r) => ({
      day: r.day,
      totalCostUsd: Number(r.total_cost_usd),
      sessionCount: Number(r.session_count),
    }));
  }

  async aggregateByPage(since: number): Promise<PageCostAggregate[]> {
    const result = (await this.db.execute(sql`
      SELECT
        page,
        SUM(cost_usd) as total_cost_usd,
        COUNT(*) as call_count,
        AVG(cost_usd) as avg_cost_usd
      FROM session_usage
      WHERE created_at > ${since} AND page IS NOT NULL
      GROUP BY page
      ORDER BY total_cost_usd DESC
    `)) as unknown as {
      rows: Array<{ page: string; total_cost_usd: string; call_count: string; avg_cost_usd: string }>;
    };
    return result.rows.map((r) => ({
      page: r.page,
      totalCostUsd: Number(r.total_cost_usd),
      callCount: Number(r.call_count),
      avgCostUsd: Number(r.avg_cost_usd),
    }));
  }

  async cacheHitRate(since: number): Promise<number> {
    const result = (await this.db.execute(sql`
      SELECT
        SUM(cached_tokens) as total_cached,
        SUM(input_tokens) as total_input
      FROM session_usage
      WHERE created_at > ${since}
    `)) as unknown as { rows: Array<{ total_cached: string | null; total_input: string | null }> };
    const cached = Number(result.rows[0]?.total_cached ?? 0);
    const input = Number(result.rows[0]?.total_input ?? 0);
    return input > 0 ? cached / input : 0;
  }
}
