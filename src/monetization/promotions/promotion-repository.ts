import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { promotions } from "../../db/schema/promotions.js";

export type PromotionStatus = "draft" | "scheduled" | "active" | "paused" | "expired" | "cancelled";
export type PromotionType = "bonus_on_purchase" | "coupon_fixed" | "coupon_unique" | "batch_grant";
export type PromotionValueType = "flat_credits" | "percent_of_purchase";
export type PromotionUserSegment = "all" | "new_users" | "existing_users" | "tenant_list";

export interface Promotion {
  id: string;
  name: string;
  type: PromotionType;
  status: PromotionStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  valueType: PromotionValueType;
  valueAmount: number;
  maxValueCredits: number | null;
  firstPurchaseOnly: boolean;
  minPurchaseCredits: number | null;
  userSegment: PromotionUserSegment;
  eligibleTenantIds: string[] | null;
  totalUseLimit: number | null;
  perUserLimit: number;
  budgetCredits: number | null;
  totalUses: number;
  totalCreditsGranted: number;
  couponCode: string | null;
  couponBatchId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  notes: string | null;
}

export type CreatePromotionInput = {
  name: string;
  type: PromotionType;
  status?: PromotionStatus;
  startsAt?: Date | null;
  endsAt?: Date | null;
  valueType: PromotionValueType;
  valueAmount: number;
  maxValueCredits?: number | null;
  firstPurchaseOnly?: boolean;
  minPurchaseCredits?: number | null;
  userSegment?: PromotionUserSegment;
  eligibleTenantIds?: string[] | null;
  totalUseLimit?: number | null;
  perUserLimit?: number;
  budgetCredits?: number | null;
  couponCode?: string | null;
  couponBatchId?: string | null;
  createdBy: string;
  notes?: string | null;
};

export interface IPromotionRepository {
  create(input: CreatePromotionInput): Promise<Promotion>;
  getById(id: string): Promise<Promotion | null>;
  list(filters?: { status?: PromotionStatus; type?: PromotionType }): Promise<Promotion[]>;
  listActive(filters?: { type?: PromotionType; now?: Date }): Promise<Promotion[]>;
  findByCouponCode(code: string): Promise<Promotion | null>;
  updateStatus(id: string, status: PromotionStatus): Promise<void>;
  update(id: string, patch: Partial<CreatePromotionInput>): Promise<void>;
  incrementUsage(id: string, creditsGranted: number): Promise<void>;
}

export class DrizzlePromotionRepository implements IPromotionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreatePromotionInput): Promise<Promotion> {
    const rows = await this.db
      .insert(promotions)
      .values({
        name: input.name,
        type: input.type,
        status: input.status ?? "draft",
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        valueType: input.valueType,
        valueAmount: input.valueAmount,
        maxValueCredits: input.maxValueCredits ?? null,
        firstPurchaseOnly: input.firstPurchaseOnly ?? false,
        minPurchaseCredits: input.minPurchaseCredits ?? null,
        userSegment: input.userSegment ?? "all",
        eligibleTenantIds: input.eligibleTenantIds ?? null,
        totalUseLimit: input.totalUseLimit ?? null,
        perUserLimit: input.perUserLimit ?? 1,
        budgetCredits: input.budgetCredits ?? null,
        couponCode: input.couponCode ?? null,
        couponBatchId: input.couponBatchId ?? null,
        createdBy: input.createdBy,
        notes: input.notes ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert promotion");
    return this.#map(row);
  }

  async getById(id: string): Promise<Promotion | null> {
    const row = (await this.db.select().from(promotions).where(eq(promotions.id, id)).limit(1))[0];
    return row ? this.#map(row) : null;
  }

  async list(filters?: { status?: PromotionStatus; type?: PromotionType }): Promise<Promotion[]> {
    const conditions = [];
    if (filters?.status) conditions.push(eq(promotions.status, filters.status));
    if (filters?.type) conditions.push(eq(promotions.type, filters.type));
    const rows =
      conditions.length > 0
        ? await this.db
            .select()
            .from(promotions)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        : await this.db.select().from(promotions);
    return rows.map((r) => this.#map(r));
  }

  async listActive(filters?: { type?: PromotionType; now?: Date }): Promise<Promotion[]> {
    const now = filters?.now ?? new Date();
    const conditions = [
      eq(promotions.status, "active"),
      or(isNull(promotions.startsAt), lte(promotions.startsAt, now)),
      or(isNull(promotions.endsAt), sql`${promotions.endsAt} >= ${now}`),
    ];
    if (filters?.type) conditions.push(eq(promotions.type, filters.type));
    const rows = await this.db
      .select()
      .from(promotions)
      .where(and(...conditions));
    return rows.map((r) => this.#map(r));
  }

  async findByCouponCode(code: string): Promise<Promotion | null> {
    const row = (await this.db.select().from(promotions).where(eq(promotions.couponCode, code)).limit(1))[0];
    return row ? this.#map(row) : null;
  }

  async updateStatus(id: string, status: PromotionStatus): Promise<void> {
    await this.db.update(promotions).set({ status, updatedAt: new Date() }).where(eq(promotions.id, id));
  }

  async update(id: string, patch: Partial<CreatePromotionInput>): Promise<void> {
    await this.db
      .update(promotions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(promotions.id, id));
  }

  async incrementUsage(id: string, creditsGranted: number): Promise<void> {
    await this.db
      .update(promotions)
      .set({
        totalUses: sql`${promotions.totalUses} + 1`,
        totalCreditsGranted: sql`${promotions.totalCreditsGranted} + ${creditsGranted}`,
        updatedAt: new Date(),
      })
      .where(eq(promotions.id, id));
  }

  #map(row: typeof promotions.$inferSelect): Promotion {
    return {
      id: row.id,
      name: row.name,
      type: row.type as PromotionType,
      status: row.status as PromotionStatus,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      valueType: row.valueType as PromotionValueType,
      valueAmount: row.valueAmount,
      maxValueCredits: row.maxValueCredits,
      firstPurchaseOnly: row.firstPurchaseOnly,
      minPurchaseCredits: row.minPurchaseCredits,
      userSegment: row.userSegment as PromotionUserSegment,
      eligibleTenantIds: row.eligibleTenantIds ?? null,
      totalUseLimit: row.totalUseLimit,
      perUserLimit: row.perUserLimit,
      budgetCredits: row.budgetCredits,
      totalUses: row.totalUses,
      totalCreditsGranted: row.totalCreditsGranted,
      couponCode: row.couponCode,
      couponBatchId: row.couponBatchId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      notes: row.notes,
    };
  }
}
