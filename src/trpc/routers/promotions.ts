/**
 * tRPC promotions router — admin management of promotions, coupon batches,
 * rate overrides, and redemption history.
 */

import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type {
  AdapterRateOverrideCache,
  IAdapterRateOverrideRepository,
} from "../../monetization/adapters/rate-override-repository.js";
import type { ICouponRepository } from "../../monetization/promotions/coupon-repository.js";
import type { IPromotionRepository } from "../../monetization/promotions/promotion-repository.js";
import type { IRedemptionRepository } from "../../monetization/promotions/redemption-repository.js";
import { adminProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface PromotionsRouterDeps {
  promotionRepo: IPromotionRepository;
  couponRepo: ICouponRepository;
  redemptionRepo: IRedemptionRepository;
  rateOverrideRepo: IAdapterRateOverrideRepository;
  rateOverrideCache: AdapterRateOverrideCache;
}

let _deps: PromotionsRouterDeps | null = null;

export function setPromotionsRouterDeps(deps: PromotionsRouterDeps): void {
  _deps = deps;
}

function getDeps(): PromotionsRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Promotions not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const promotionStatusSchema = z.enum(["draft", "scheduled", "active", "paused", "expired", "cancelled"]);
const promotionTypeSchema = z.enum(["bonus_on_purchase", "coupon_fixed", "coupon_unique", "batch_grant"]);
const promotionValueTypeSchema = z.enum(["flat_credits", "percent_of_purchase"]);
const promotionUserSegmentSchema = z.enum(["all", "new_users", "existing_users", "tenant_list"]);
const rateOverrideStatusSchema = z.enum(["scheduled", "active", "expired", "cancelled"]);

const createPromotionSchema = z.object({
  name: z.string().min(1).max(255),
  type: promotionTypeSchema,
  status: promotionStatusSchema.optional(),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  valueType: promotionValueTypeSchema,
  valueAmount: z.number().int().min(0),
  maxValueCredits: z.number().int().min(0).optional().nullable(),
  firstPurchaseOnly: z.boolean().optional(),
  minPurchaseCredits: z.number().int().min(0).optional().nullable(),
  userSegment: promotionUserSegmentSchema.optional(),
  eligibleTenantIds: z.array(z.string()).optional().nullable(),
  totalUseLimit: z.number().int().min(1).optional().nullable(),
  perUserLimit: z.number().int().min(1).optional(),
  budgetCredits: z.number().int().min(0).optional().nullable(),
  couponCode: z.string().min(1).max(100).optional().nullable(),
  couponBatchId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// ---------------------------------------------------------------------------
// Promotions sub-router
// ---------------------------------------------------------------------------

const promotionsSubRouter = router({
  /** List promotions with optional filters. */
  list: adminProcedure
    .input(
      z.object({
        status: promotionStatusSchema.optional(),
        type: promotionTypeSchema.optional(),
      }),
    )
    .query(({ input }) => {
      const { promotionRepo } = getDeps();
      return promotionRepo.list({ status: input.status, type: input.type });
    }),

  /** Get a single promotion by ID. */
  get: adminProcedure.input(z.object({ id: z.string().uuid() })).query(({ input }) => {
    const { promotionRepo } = getDeps();
    return promotionRepo.getById(input.id);
  }),

  /** Create a new promotion. */
  create: adminProcedure.input(createPromotionSchema).mutation(({ input, ctx }) => {
    const { promotionRepo } = getDeps();
    return promotionRepo.create({
      ...input,
      createdBy: ctx.user.id,
    });
  }),

  /** Update a promotion (only allowed for draft or scheduled). */
  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        startsAt: z.coerce.date().optional().nullable(),
        endsAt: z.coerce.date().optional().nullable(),
        valueType: promotionValueTypeSchema.optional(),
        valueAmount: z.number().int().min(0).optional(),
        maxValueCredits: z.number().int().min(0).optional().nullable(),
        firstPurchaseOnly: z.boolean().optional(),
        minPurchaseCredits: z.number().int().min(0).optional().nullable(),
        userSegment: promotionUserSegmentSchema.optional(),
        eligibleTenantIds: z.array(z.string()).optional().nullable(),
        totalUseLimit: z.number().int().min(1).optional().nullable(),
        perUserLimit: z.number().int().min(1).optional(),
        budgetCredits: z.number().int().min(0).optional().nullable(),
        couponCode: z.string().min(1).max(100).optional().nullable(),
        notes: z.string().optional().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      const { promotionRepo } = getDeps();
      const { id, ...patch } = input;
      const existing = await promotionRepo.getById(id);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found" });
      if (existing.status !== "draft" && existing.status !== "scheduled") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only draft or scheduled promotions can be updated" });
      }
      await promotionRepo.update(id, patch);
    }),

  /** Activate a promotion (sets to active or scheduled based on startsAt). */
  activate: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const { promotionRepo } = getDeps();
    const existing = await promotionRepo.getById(input.id);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found" });
    const newStatus = existing.startsAt && existing.startsAt > new Date() ? "scheduled" : "active";
    await promotionRepo.updateStatus(input.id, newStatus);
  }),

  /** Pause an active promotion. */
  pause: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const { promotionRepo } = getDeps();
    const existing = await promotionRepo.getById(input.id);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found" });
    await promotionRepo.updateStatus(input.id, "paused");
  }),

  /** Cancel a promotion. */
  cancel: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const { promotionRepo } = getDeps();
    const existing = await promotionRepo.getById(input.id);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found" });
    await promotionRepo.updateStatus(input.id, "cancelled");
  }),

  /** Generate a batch of unique coupon codes for a promotion. */
  generateCouponBatch: adminProcedure
    .input(
      z.object({
        promotionId: z.string().uuid(),
        count: z.number().int().min(1).max(10000),
      }),
    )
    .mutation(async ({ input }) => {
      const { couponRepo } = getDeps();
      const codes = Array.from({ length: input.count }, () => ({
        code: crypto.randomBytes(6).toString("base64url").toUpperCase(),
      }));
      await couponRepo.createBatch(input.promotionId, codes);
      return { generated: input.count };
    }),

  /** List redemptions for a promotion. */
  listRedemptions: adminProcedure
    .input(
      z.object({
        promotionId: z.string().uuid(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .query(({ input }) => {
      const { redemptionRepo } = getDeps();
      return redemptionRepo.listByPromotion(input.promotionId, input.limit);
    }),
});

// ---------------------------------------------------------------------------
// Rate overrides sub-router
// ---------------------------------------------------------------------------

const rateOverridesSubRouter = router({
  /** List rate overrides with optional filters. */
  list: adminProcedure
    .input(
      z.object({
        status: rateOverrideStatusSchema.optional(),
        adapterId: z.string().optional(),
      }),
    )
    .query(({ input }) => {
      const { rateOverrideRepo } = getDeps();
      return rateOverrideRepo.list({ status: input.status, adapterId: input.adapterId });
    }),

  /** Create a new rate override. */
  create: adminProcedure
    .input(
      z.object({
        adapterId: z.string().min(1).max(255),
        name: z.string().min(1).max(255),
        discountPercent: z.number().min(0).max(100),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date().optional().nullable(),
        notes: z.string().optional().nullable(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { rateOverrideRepo } = getDeps();
      const status = input.startsAt > new Date() ? ("scheduled" as const) : ("active" as const);
      return rateOverrideRepo.create({
        adapterId: input.adapterId,
        name: input.name,
        discountPercent: input.discountPercent,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        status,
        createdBy: ctx.user.id,
        notes: input.notes ?? null,
      });
    }),

  /** Cancel a rate override and invalidate its cache entry. */
  cancel: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const { rateOverrideRepo, rateOverrideCache } = getDeps();
    const existing = await rateOverrideRepo.getById(input.id);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Rate override not found" });
    await rateOverrideRepo.updateStatus(input.id, "cancelled");
    rateOverrideCache.invalidate(existing.adapterId);
  }),
});

// ---------------------------------------------------------------------------
// Composed router
// ---------------------------------------------------------------------------

export const promotionsRouter = promotionsSubRouter;
export const rateOverridesRouter = rateOverridesSubRouter;
