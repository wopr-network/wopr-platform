import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import type { CreatePromotionInput } from "./promotion-repository.js";
import { DrizzlePromotionRepository } from "./promotion-repository.js";

const basePromotion: CreatePromotionInput = {
  name: "Test Promo",
  type: "coupon_fixed",
  status: "active",
  valueType: "flat_credits",
  valueAmount: 500,
  userSegment: "all",
  perUserLimit: 1,
  createdBy: "admin-1",
};

describe("DrizzlePromotionRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzlePromotionRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzlePromotionRepository(db);
  });

  describe("create", () => {
    it("returns a promotion with id, correct fields, totalUses=0", async () => {
      const promo = await repo.create(basePromotion);
      expect(promo.id).toBeTruthy();
      expect(promo.name).toBe("Test Promo");
      expect(promo.type).toBe("coupon_fixed");
      expect(promo.status).toBe("active");
      expect(promo.totalUses).toBe(0);
      expect(promo.totalCreditsGranted).toBe(0);
    });
  });

  describe("listActive", () => {
    it("returns only active promotions of the requested type", async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 1000 * 60);
      const future = new Date(now.getTime() + 1000 * 60 * 60);

      // Active, correct type
      await repo.create({ ...basePromotion, type: "coupon_fixed", startsAt: past, endsAt: future });
      // Active, different type
      await repo.create({ ...basePromotion, type: "bonus_on_purchase", startsAt: past, endsAt: future });
      // Draft — should not appear
      await repo.create({ ...basePromotion, type: "coupon_fixed", status: "draft", startsAt: past, endsAt: future });
      // Expired (ends_at in past) — should not appear
      await repo.create({ ...basePromotion, type: "coupon_fixed", startsAt: past, endsAt: past });

      const results = await repo.listActive({ type: "coupon_fixed", now });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("coupon_fixed");
    });

    it("returns all active promotions when no type filter", async () => {
      const past = new Date(Date.now() - 1000 * 60);
      await repo.create({ ...basePromotion, type: "coupon_fixed", startsAt: past });
      await repo.create({ ...basePromotion, type: "bonus_on_purchase", startsAt: past });

      const results = await repo.listActive();
      expect(results).toHaveLength(2);
    });
  });

  describe("findByCouponCode", () => {
    it("returns matching active promotion", async () => {
      await repo.create({ ...basePromotion, couponCode: "SAVE10" });
      const found = await repo.findByCouponCode("SAVE10");
      expect(found).not.toBeNull();
      expect(found?.couponCode).toBe("SAVE10");
    });

    it("returns null for non-existent code", async () => {
      const found = await repo.findByCouponCode("NOPE");
      expect(found).toBeNull();
    });
  });

  describe("incrementUsage", () => {
    it("increments totalUses by 1 and totalCreditsGranted by the given amount", async () => {
      const promo = await repo.create(basePromotion);
      await repo.incrementUsage(promo.id, 200);
      const updated = await repo.getById(promo.id);
      expect(updated?.totalUses).toBe(1);
      expect(updated?.totalCreditsGranted).toBe(200);
    });
  });

  describe("updateStatus", () => {
    it("changes status correctly", async () => {
      const promo = await repo.create({ ...basePromotion, status: "draft" });
      await repo.updateStatus(promo.id, "active");
      const updated = await repo.getById(promo.id);
      expect(updated?.status).toBe("active");
    });
  });

  describe("incrementUsageIfBudgetAllows", () => {
    it("returns true and increments when budget allows", async () => {
      const promo = await repo.create({ ...basePromotion, budgetCredits: 1000 });
      const granted = await repo.incrementUsageIfBudgetAllows(promo.id, 200, 1000);
      expect(granted).toBe(true);
      const updated = await repo.getById(promo.id);
      expect(updated?.totalUses).toBe(1);
      expect(updated?.totalCreditsGranted).toBe(200);
    });

    it("returns false and does not increment when budget would be exceeded", async () => {
      const promo = await repo.create({ ...basePromotion, budgetCredits: 500 });
      // Pre-increment to 400 using incrementUsage
      await repo.incrementUsage(promo.id, 400);
      // Trying to add 200 more would exceed budget of 500
      const granted = await repo.incrementUsageIfBudgetAllows(promo.id, 200, 500);
      expect(granted).toBe(false);
      const updated = await repo.getById(promo.id);
      expect(updated?.totalCreditsGranted).toBe(400); // unchanged
    });

    it("returns true and increments when budgetCredits is null (no budget limit)", async () => {
      const promo = await repo.create({ ...basePromotion, budgetCredits: null });
      const granted = await repo.incrementUsageIfBudgetAllows(promo.id, 999999, null);
      expect(granted).toBe(true);
      const updated = await repo.getById(promo.id);
      expect(updated?.totalCreditsGranted).toBe(999999);
    });
  });
});
