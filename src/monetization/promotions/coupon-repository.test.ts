import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleCouponRepository } from "./coupon-repository.js";
import type { CreatePromotionInput } from "./promotion-repository.js";
import { DrizzlePromotionRepository } from "./promotion-repository.js";

const basePromotion: CreatePromotionInput = {
  name: "Test Promo",
  type: "coupon_unique",
  status: "active",
  valueType: "flat_credits",
  valueAmount: 500,
  userSegment: "all",
  perUserLimit: 1,
  createdBy: "admin-1",
};

describe("DrizzleCouponRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleCouponRepository;
  let promoRepo: DrizzlePromotionRepository;
  let promotionId: string;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleCouponRepository(db);
    promoRepo = new DrizzlePromotionRepository(db);
    const promo = await promoRepo.create(basePromotion);
    promotionId = promo.id;
  });

  describe("createBatch and findByCode", () => {
    it("findByCode returns the code with correct fields after createBatch", async () => {
      await repo.createBatch(promotionId, [{ code: "ALPHA123", assignedEmail: "user@example.com" }]);
      const found = await repo.findByCode("ALPHA123");
      expect(found).not.toBeNull();
      expect(found?.code).toBe("ALPHA123");
      expect(found?.promotionId).toBe(promotionId);
      expect(found?.assignedEmail).toBe("user@example.com");
      expect(found?.redeemedAt).toBeNull();
      expect(found?.redeemedByTenantId).toBeNull();
    });

    it("findByCode returns null for non-existent code", async () => {
      const found = await repo.findByCode("NOPE");
      expect(found).toBeNull();
    });
  });

  describe("redeem", () => {
    it("sets redeemedAt and redeemedByTenantId", async () => {
      await repo.createBatch(promotionId, [{ code: "REDEEM1" }]);
      const code = await repo.findByCode("REDEEM1");
      expect(code).not.toBeNull();
      if (!code) throw new Error("code not found");
      await repo.redeem(code.id, "tenant-xyz");
      const after = await repo.findByCode("REDEEM1");
      expect(after?.redeemedAt).not.toBeNull();
      expect(after?.redeemedByTenantId).toBe("tenant-xyz");
    });
  });

  describe("getUserRedemptionCount", () => {
    it("returns 0 before redemption", async () => {
      const count = await repo.getUserRedemptionCount(promotionId, "tenant-abc");
      expect(count).toBe(0);
    });

    it("returns 1 after redemption by that tenant", async () => {
      await repo.createBatch(promotionId, [{ code: "COUNTME" }]);
      const code = await repo.findByCode("COUNTME");
      if (!code) throw new Error("code not found");
      await repo.redeem(code.id, "tenant-abc");
      const count = await repo.getUserRedemptionCount(promotionId, "tenant-abc");
      expect(count).toBe(1);
    });
  });

  describe("listByPromotion", () => {
    it("returns all codes for the promotion", async () => {
      await repo.createBatch(promotionId, [{ code: "A1" }, { code: "B2" }, { code: "C3" }]);
      const list = await repo.listByPromotion(promotionId);
      expect(list).toHaveLength(3);
      const codes = list.map((c) => c.code);
      expect(codes).toContain("A1");
      expect(codes).toContain("B2");
      expect(codes).toContain("C3");
    });
  });

  describe("countRedeemed", () => {
    it("returns 0 when none redeemed", async () => {
      await repo.createBatch(promotionId, [{ code: "X1" }]);
      expect(await repo.countRedeemed(promotionId)).toBe(0);
    });

    it("returns 1 after one redemption", async () => {
      await repo.createBatch(promotionId, [{ code: "Y1" }]);
      const code = await repo.findByCode("Y1");
      if (!code) throw new Error("code not found");
      await repo.redeem(code.id, "tenant-r");
      expect(await repo.countRedeemed(promotionId)).toBe(1);
    });
  });
});
