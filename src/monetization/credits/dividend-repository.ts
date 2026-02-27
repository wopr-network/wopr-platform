import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/admin-users.js";
import { creditTransactions } from "../../db/schema/credits.js";
import { dividendDistributions } from "../../db/schema/dividend-distributions.js";
import type { DividendHistoryEntry, DividendStats } from "../repository-types.js";

export type { DividendHistoryEntry, DividendStats };

export interface DigestTenantRow {
  tenantId: string;
  totalCredits: number;
  distributionCount: number;
  avgPoolCredits: number;
  avgActiveUsers: number;
}

export interface IDividendRepository {
  getStats(tenantId: string): Promise<DividendStats>;
  getHistory(tenantId: string, limit: number, offset: number): Promise<DividendHistoryEntry[]>;
  getLifetimeTotalCredits(tenantId: string): Promise<number>;
  /** Aggregate dividend distributions per tenant for a date window [windowStart, windowEnd). */
  getDigestTenantAggregates(windowStart: string, windowEnd: string): Promise<DigestTenantRow[]>;
  /** Resolve email for a tenant from admin_users. Returns undefined if no row exists. */
  getTenantEmail(tenantId: string): Promise<string | undefined>;
}

export class DrizzleDividendRepository implements IDividendRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getStats(tenantId: string): Promise<DividendStats> {
    // 1. Pool = sum of purchase amounts from yesterday UTC
    const poolRow = (
      await this.db
        .select({ total: sql<number>`COALESCE(SUM(${creditTransactions.amountCredits}), 0)` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.type, "purchase"),
            sql`${creditTransactions.createdAt}::timestamp >= date_trunc('day', NOW()) - INTERVAL '1 day'`,
            sql`${creditTransactions.createdAt}::timestamp < date_trunc('day', NOW())`,
          ),
        )
    )[0];
    const poolCredits = poolRow?.total ?? 0;

    // 2. Active users = distinct tenants with a purchase in the last 7 days
    const activeRow = (
      await this.db
        .select({ count: sql<number>`COUNT(DISTINCT ${creditTransactions.tenantId})` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.type, "purchase"),
            sql`${creditTransactions.createdAt}::timestamp >= NOW() - INTERVAL '7 days'`,
          ),
        )
    )[0];
    const activeUsers = activeRow?.count ?? 0;

    // 3. Per-user projection (avoid division by zero)
    const perUserCredits = activeUsers > 0 ? Math.floor(poolCredits / activeUsers) : 0;

    // 4. Next distribution = midnight UTC tonight
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    const nextDistributionAt = nextMidnight.toISOString();

    // 5. User eligibility — last purchase within 7 days
    const userPurchaseRow = (
      await this.db
        .select({ createdAt: creditTransactions.createdAt })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.tenantId, tenantId), eq(creditTransactions.type, "purchase")))
        .orderBy(desc(creditTransactions.createdAt))
        .limit(1)
    )[0];

    let userEligible = false;
    let userLastPurchaseAt: string | null = null;
    let userWindowExpiresAt: string | null = null;

    if (userPurchaseRow) {
      const rawTs = userPurchaseRow.createdAt;
      // Parse the timestamp directly. PGlite may return ISO strings with or without
      // timezone suffix. JavaScript's Date constructor handles ISO 8601 strings natively.
      const lastPurchase = new Date(rawTs);
      userLastPurchaseAt = lastPurchase.toISOString();

      const windowExpiry = new Date(lastPurchase.getTime() + 7 * 24 * 60 * 60 * 1000);
      userWindowExpiresAt = windowExpiry.toISOString();

      userEligible = windowExpiry.getTime() > Date.now();
    }

    return {
      poolCredits,
      activeUsers,
      perUserCredits,
      nextDistributionAt,
      userEligible,
      userLastPurchaseAt,
      userWindowExpiresAt,
    };
  }

  async getHistory(tenantId: string, limit: number, offset: number): Promise<DividendHistoryEntry[]> {
    const safeLimit = Math.min(Math.max(1, limit), 250);
    const safeOffset = Math.max(0, offset);

    return this.db
      .select({
        date: dividendDistributions.date,
        amountCredits: dividendDistributions.amountCredits,
        poolCredits: dividendDistributions.poolCredits,
        activeUsers: dividendDistributions.activeUsers,
      })
      .from(dividendDistributions)
      .where(eq(dividendDistributions.tenantId, tenantId))
      .orderBy(desc(dividendDistributions.date))
      .limit(safeLimit)
      .offset(safeOffset);
  }

  async getLifetimeTotalCredits(tenantId: string): Promise<number> {
    const row = (
      await this.db
        .select({ total: sql<number>`COALESCE(SUM(${dividendDistributions.amountCredits}), 0)` })
        .from(dividendDistributions)
        .where(eq(dividendDistributions.tenantId, tenantId))
    )[0];
    return row?.total ?? 0;
  }

  async getDigestTenantAggregates(windowStart: string, windowEnd: string): Promise<DigestTenantRow[]> {
    return this.db
      .select({
        tenantId: dividendDistributions.tenantId,
        totalCredits: sql<number>`SUM(${dividendDistributions.amountCredits})`,
        distributionCount: sql<number>`COUNT(DISTINCT ${dividendDistributions.date})`,
        avgPoolCredits: sql<number>`CAST(AVG(${dividendDistributions.poolCredits}) AS INTEGER)`,
        avgActiveUsers: sql<number>`CAST(AVG(${dividendDistributions.activeUsers}) AS INTEGER)`,
      })
      .from(dividendDistributions)
      .where(and(gte(dividendDistributions.date, windowStart), lt(dividendDistributions.date, windowEnd)))
      .groupBy(dividendDistributions.tenantId);
  }

  async getTenantEmail(tenantId: string): Promise<string | undefined> {
    const row = (
      await this.db
        .select({ email: adminUsers.email })
        .from(adminUsers)
        .where(eq(adminUsers.tenantId, tenantId))
        .limit(1)
    )[0];
    return row?.email;
  }
}
