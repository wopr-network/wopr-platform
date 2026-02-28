import { and, count, eq, gt, isNotNull } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { promotionRedemptions } from "../../db/schema/promotion-redemptions.js";

export interface Redemption {
  id: string;
  promotionId: string;
  tenantId: string;
  couponCodeId: string | null;
  creditsGranted: number;
  creditTransactionId: string;
  purchaseAmountCredits: number | null;
  redeemedAt: Date;
}

export interface IRedemptionRepository {
  create(input: {
    promotionId: string;
    tenantId: string;
    couponCodeId?: string;
    creditsGranted: number;
    creditTransactionId: string;
    purchaseAmountCredits?: number;
  }): Promise<Redemption>;
  listByPromotion(promotionId: string, limit?: number, cursor?: string): Promise<Redemption[]>;
  countByTenant(promotionId: string, tenantId: string): Promise<number>;
  /** Returns true if the tenant has made at least one prior purchase (has any purchase-triggered redemption). */
  hasPriorPurchase(tenantId: string): Promise<boolean>;
}

export class DrizzleRedemptionRepository implements IRedemptionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: {
    promotionId: string;
    tenantId: string;
    couponCodeId?: string;
    creditsGranted: number;
    creditTransactionId: string;
    purchaseAmountCredits?: number;
  }): Promise<Redemption> {
    const rows = await this.db
      .insert(promotionRedemptions)
      .values({
        promotionId: input.promotionId,
        tenantId: input.tenantId,
        couponCodeId: input.couponCodeId ?? null,
        creditsGranted: input.creditsGranted,
        creditTransactionId: input.creditTransactionId,
        purchaseAmountCredits: input.purchaseAmountCredits ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert redemption");
    return this.#map(row);
  }

  async listByPromotion(promotionId: string, limit?: number, _cursor?: string): Promise<Redemption[]> {
    let query = this.db
      .select()
      .from(promotionRedemptions)
      .where(eq(promotionRedemptions.promotionId, promotionId))
      .$dynamic();
    if (limit) query = query.limit(limit);
    const rows = await query;
    return rows.map((r) => this.#map(r));
  }

  async countByTenant(promotionId: string, tenantId: string): Promise<number> {
    const row = (
      await this.db
        .select({ total: count() })
        .from(promotionRedemptions)
        .where(and(eq(promotionRedemptions.promotionId, promotionId), eq(promotionRedemptions.tenantId, tenantId)))
    )[0];
    return row?.total ?? 0;
  }

  async hasPriorPurchase(tenantId: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ total: count() })
        .from(promotionRedemptions)
        .where(
          and(
            eq(promotionRedemptions.tenantId, tenantId),
            isNotNull(promotionRedemptions.purchaseAmountCredits),
            gt(promotionRedemptions.purchaseAmountCredits, 0),
          ),
        )
        .limit(1)
    )[0];
    return (row?.total ?? 0) > 0;
  }

  #map(row: typeof promotionRedemptions.$inferSelect): Redemption {
    return {
      id: row.id,
      promotionId: row.promotionId,
      tenantId: row.tenantId,
      couponCodeId: row.couponCodeId ?? null,
      creditsGranted: row.creditsGranted,
      creditTransactionId: row.creditTransactionId,
      purchaseAmountCredits: row.purchaseAmountCredits ?? null,
      redeemedAt: row.redeemedAt,
    };
  }
}
