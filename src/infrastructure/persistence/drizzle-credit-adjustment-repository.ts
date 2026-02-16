import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditAdjustments } from "../../db/schema/credit-adjustments.js";
import type {
  AdjustmentFilters,
  AdjustmentType,
  CreditAdjustment,
  CreditAdjustmentRepository,
} from "../../domain/repositories/credit-adjustment-repository.js";

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 50;

function mapRowToCreditAdjustment(row: typeof creditAdjustments.$inferSelect): CreditAdjustment {
  return {
    id: row.id,
    tenant: row.tenant,
    type: row.type as AdjustmentType,
    amount_cents: row.amountCents,
    reason: row.reason,
    admin_user: row.adminUser,
    reference_ids: row.referenceIds,
    created_at: row.createdAt,
  };
}

export class DrizzleCreditAdjustmentRepository implements CreditAdjustmentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async grant(
    tenant: string,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds?: string[],
  ): Promise<CreditAdjustment> {
    if (amountCents <= 0) throw new Error("amount_cents must be positive for grants");
    if (!reason.trim()) throw new Error("reason is required");

    const refIds = referenceIds && referenceIds.length > 0 ? JSON.stringify(referenceIds) : null;
    return this.insert(tenant, "grant", amountCents, reason, adminUser, refIds);
  }

  async hasReferenceId(referenceId: string): Promise<boolean> {
    const row = await this.db
      .select()
      .from(creditAdjustments)
      .where(sql`${creditAdjustments.referenceIds} LIKE ${`%${referenceId}%`}`)
      .limit(1);
    return row.length > 0;
  }

  async refund(
    tenant: string,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds?: string[],
  ): Promise<CreditAdjustment> {
    if (amountCents <= 0) throw new Error("amount_cents must be positive for refunds");
    if (!reason.trim()) throw new Error("reason is required");

    const refIds = referenceIds && referenceIds.length > 0 ? JSON.stringify(referenceIds) : null;

    const balance = await this.getBalance(tenant);
    if (balance - amountCents < 0) {
      throw new BalanceError(
        `Insufficient balance: current ${balance} cents, requested refund ${amountCents} cents`,
        balance,
      );
    }

    return this.insert(tenant, "refund", -amountCents, reason, adminUser, refIds);
  }

  async correction(tenant: string, amountCents: number, reason: string, adminUser: string): Promise<CreditAdjustment> {
    if (!reason.trim()) throw new Error("reason is required");

    if (amountCents < 0) {
      const balance = await this.getBalance(tenant);
      if (balance + amountCents < 0) {
        throw new BalanceError(
          `Correction would result in negative balance: current ${balance} cents, correction ${amountCents} cents`,
          balance,
        );
      }
    }

    return this.insert(tenant, "correction", amountCents, reason, adminUser, null);
  }

  async getBalance(tenant: string): Promise<number> {
    const row = await this.db
      .select({ balance: sql<number>`COALESCE(SUM(${creditAdjustments.amountCents}), 0)`.as("balance") })
      .from(creditAdjustments)
      .where(eq(creditAdjustments.tenant, tenant));
    return row[0]?.balance ?? 0;
  }

  async listTransactions(
    tenant: string,
    filters: AdjustmentFilters = {},
  ): Promise<{ entries: CreditAdjustment[]; total: number }> {
    const conditions = [eq(creditAdjustments.tenant, tenant)];

    if (filters.type) {
      conditions.push(eq(creditAdjustments.type, filters.type));
    }

    if (filters.from != null) {
      conditions.push(sql`${creditAdjustments.createdAt} >= ${filters.from}`);
    }

    if (filters.to != null) {
      conditions.push(sql`${creditAdjustments.createdAt} <= ${filters.to}`);
    }

    const whereClause = and(...conditions);

    const countResult = await this.db
      .select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(creditAdjustments)
      .where(whereClause);
    const total = countResult[0]?.count ?? 0;

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const rows = await this.db
      .select()
      .from(creditAdjustments)
      .where(whereClause)
      .orderBy(desc(creditAdjustments.createdAt))
      .limit(limit)
      .offset(offset);

    const entries = rows.map(mapRowToCreditAdjustment);

    return { entries, total };
  }

  async getTransaction(transactionId: string): Promise<CreditAdjustment | null> {
    const row = await this.db.select().from(creditAdjustments).where(eq(creditAdjustments.id, transactionId)).limit(1);
    return row[0] ? mapRowToCreditAdjustment(row[0]) : null;
  }

  private async insert(
    tenant: string,
    type: AdjustmentType,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds: string | null,
  ): Promise<CreditAdjustment> {
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    await this.db.insert(creditAdjustments).values({
      id,
      tenant,
      type,
      amountCents,
      reason,
      adminUser,
      referenceIds,
      createdAt,
    });

    return {
      id,
      tenant,
      type,
      amount_cents: amountCents,
      reason,
      admin_user: adminUser,
      reference_ids: referenceIds,
      created_at: createdAt,
    };
  }
}

export class BalanceError extends Error {
  currentBalance: number;

  constructor(message: string, currentBalance: number) {
    super(message);
    this.name = "BalanceError";
    this.currentBalance = currentBalance;
  }
}
