import { and, count, eq, isNotNull } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { couponCodes } from "../../db/schema/coupon-codes.js";

export interface CouponCode {
  id: string;
  promotionId: string;
  code: string;
  assignedTenantId: string | null;
  assignedEmail: string | null;
  redeemedAt: Date | null;
  redeemedByTenantId: string | null;
}

export interface ICouponRepository {
  createBatch(
    promotionId: string,
    codes: Array<{ code: string; assignedTenantId?: string; assignedEmail?: string }>,
  ): Promise<void>;
  findByCode(code: string): Promise<CouponCode | null>;
  redeem(codeId: string, tenantId: string): Promise<void>;
  listByPromotion(promotionId: string, limit?: number, cursor?: string): Promise<CouponCode[]>;
  countRedeemed(promotionId: string): Promise<number>;
  getUserRedemptionCount(promotionId: string, tenantId: string): Promise<number>;
}

export class DrizzleCouponRepository implements ICouponRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createBatch(
    promotionId: string,
    codes: Array<{ code: string; assignedTenantId?: string; assignedEmail?: string }>,
  ): Promise<void> {
    if (codes.length === 0) return;
    await this.db.insert(couponCodes).values(
      codes.map((c) => ({
        promotionId,
        code: c.code,
        assignedTenantId: c.assignedTenantId ?? null,
        assignedEmail: c.assignedEmail ?? null,
      })),
    );
  }

  async findByCode(code: string): Promise<CouponCode | null> {
    const row = (await this.db.select().from(couponCodes).where(eq(couponCodes.code, code)).limit(1))[0];
    return row ? this.#map(row) : null;
  }

  async redeem(codeId: string, tenantId: string): Promise<void> {
    await this.db
      .update(couponCodes)
      .set({ redeemedAt: new Date(), redeemedByTenantId: tenantId })
      .where(eq(couponCodes.id, codeId));
  }

  async listByPromotion(promotionId: string, limit?: number, _cursor?: string): Promise<CouponCode[]> {
    let query = this.db.select().from(couponCodes).where(eq(couponCodes.promotionId, promotionId)).$dynamic();
    if (limit) query = query.limit(limit);
    const rows = await query;
    return rows.map((r) => this.#map(r));
  }

  async countRedeemed(promotionId: string): Promise<number> {
    const row = (
      await this.db
        .select({ total: count() })
        .from(couponCodes)
        .where(and(eq(couponCodes.promotionId, promotionId), isNotNull(couponCodes.redeemedAt)))
    )[0];
    return row?.total ?? 0;
  }

  async getUserRedemptionCount(promotionId: string, tenantId: string): Promise<number> {
    const row = (
      await this.db
        .select({ total: count() })
        .from(couponCodes)
        .where(and(eq(couponCodes.promotionId, promotionId), eq(couponCodes.redeemedByTenantId, tenantId)))
    )[0];
    return row?.total ?? 0;
  }

  #map(row: typeof couponCodes.$inferSelect): CouponCode {
    return {
      id: row.id,
      promotionId: row.promotionId,
      code: row.code,
      assignedTenantId: row.assignedTenantId ?? null,
      assignedEmail: row.assignedEmail ?? null,
      redeemedAt: row.redeemedAt ?? null,
      redeemedByTenantId: row.redeemedByTenantId ?? null,
    };
  }
}
