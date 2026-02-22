import { and, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditTransactions } from "../../db/schema/credits.js";
import { dividendDistributions } from "../../db/schema/dividend-distributions.js";

export interface DividendStats {
  poolCents: number;
  activeUsers: number;
  perUserCents: number;
  nextDistributionAt: string;
  userEligible: boolean;
  userLastPurchaseAt: string | null;
  userWindowExpiresAt: string | null;
}

export interface DividendHistoryEntry {
  date: string;
  amountCents: number;
  poolCents: number;
  activeUsers: number;
}

export interface IDividendRepository {
  getStats(tenantId: string): DividendStats;
  getHistory(tenantId: string, limit: number, offset: number): DividendHistoryEntry[];
  getLifetimeTotalCents(tenantId: string): number;
}

export class DrizzleDividendRepository implements IDividendRepository {
  constructor(private readonly db: DrizzleDb) {}

  getStats(tenantId: string): DividendStats {
    // 1. Pool = sum of purchase amounts from yesterday UTC
    const poolRow = this.db
      .select({ total: sql<number>`COALESCE(SUM(${creditTransactions.amountCents}), 0)` })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, "purchase"),
          sql`${creditTransactions.createdAt} >= datetime('now', '-1 day', 'start of day')`,
          sql`${creditTransactions.createdAt} < datetime('now', 'start of day')`,
        ),
      )
      .get();
    const poolCents = poolRow?.total ?? 0;

    // 2. Active users = distinct tenants with a purchase in the last 7 days
    const activeRow = this.db
      .select({ count: sql<number>`COUNT(DISTINCT ${creditTransactions.tenantId})` })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, "purchase"),
          sql`${creditTransactions.createdAt} >= datetime('now', '-7 days')`,
        ),
      )
      .get();
    const activeUsers = activeRow?.count ?? 0;

    // 3. Per-user projection (avoid division by zero)
    const perUserCents = activeUsers > 0 ? Math.floor(poolCents / activeUsers) : 0;

    // 4. Next distribution = midnight UTC tonight
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    const nextDistributionAt = nextMidnight.toISOString();

    // 5. User eligibility — last purchase within 7 days
    const userPurchaseRow = this.db
      .select({ createdAt: creditTransactions.createdAt })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.tenantId, tenantId), eq(creditTransactions.type, "purchase")))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(1)
      .get();

    let userEligible = false;
    let userLastPurchaseAt: string | null = null;
    let userWindowExpiresAt: string | null = null;

    if (userPurchaseRow) {
      // SQLite stores as "YYYY-MM-DD HH:MM:SS", convert to ISO 8601
      const lastPurchase = new Date(`${userPurchaseRow.createdAt}Z`);
      userLastPurchaseAt = lastPurchase.toISOString();

      const windowExpiry = new Date(lastPurchase.getTime() + 7 * 24 * 60 * 60 * 1000);
      userWindowExpiresAt = windowExpiry.toISOString();

      userEligible = windowExpiry.getTime() > Date.now();
    }

    return {
      poolCents,
      activeUsers,
      perUserCents,
      nextDistributionAt,
      userEligible,
      userLastPurchaseAt,
      userWindowExpiresAt,
    };
  }

  getHistory(tenantId: string, limit: number, offset: number): DividendHistoryEntry[] {
    const safeLimit = Math.min(Math.max(1, limit), 250);
    const safeOffset = Math.max(0, offset);

    return this.db
      .select({
        date: dividendDistributions.date,
        amountCents: dividendDistributions.amountCents,
        poolCents: dividendDistributions.poolCents,
        activeUsers: dividendDistributions.activeUsers,
      })
      .from(dividendDistributions)
      .where(eq(dividendDistributions.tenantId, tenantId))
      .orderBy(desc(dividendDistributions.date))
      .limit(safeLimit)
      .offset(safeOffset)
      .all();
  }

  getLifetimeTotalCents(tenantId: string): number {
    const row = this.db
      .select({ total: sql<number>`COALESCE(SUM(${dividendDistributions.amountCents}), 0)` })
      .from(dividendDistributions)
      .where(eq(dividendDistributions.tenantId, tenantId))
      .get();
    return row?.total ?? 0;
  }
}
