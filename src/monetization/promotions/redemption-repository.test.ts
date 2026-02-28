import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import type { CreatePromotionInput } from "./promotion-repository.js";
import { DrizzlePromotionRepository } from "./promotion-repository.js";
import { DrizzleRedemptionRepository } from "./redemption-repository.js";

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

describe("DrizzleRedemptionRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleRedemptionRepository;
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
    repo = new DrizzleRedemptionRepository(db);
    promoRepo = new DrizzlePromotionRepository(db);
    const promo = await promoRepo.create(basePromotion);
    promotionId = promo.id;
  });

  describe("create", () => {
    it("returns redemption with correct fields", async () => {
      const r = await repo.create({
        promotionId,
        tenantId: "tenant-1",
        creditsGranted: 200,
        creditTransactionId: "tx-abc",
        purchaseAmountCredits: 1000,
      });
      expect(r.id).toBeTruthy();
      expect(r.promotionId).toBe(promotionId);
      expect(r.tenantId).toBe("tenant-1");
      expect(r.creditsGranted).toBe(200);
      expect(r.creditTransactionId).toBe("tx-abc");
      expect(r.purchaseAmountCredits).toBe(1000);
      expect(r.couponCodeId).toBeNull();
      expect(r.redeemedAt).toBeInstanceOf(Date);
    });
  });

  describe("countByTenant", () => {
    it("returns 0 initially", async () => {
      expect(await repo.countByTenant(promotionId, "tenant-1")).toBe(0);
    });

    it("returns 1 after one redemption", async () => {
      await repo.create({ promotionId, tenantId: "tenant-1", creditsGranted: 100, creditTransactionId: "tx-1" });
      expect(await repo.countByTenant(promotionId, "tenant-1")).toBe(1);
    });
  });

  describe("listByPromotion", () => {
    it("returns all redemptions for a promotion", async () => {
      await repo.create({ promotionId, tenantId: "t1", creditsGranted: 100, creditTransactionId: "tx-a" });
      await repo.create({ promotionId, tenantId: "t2", creditsGranted: 200, creditTransactionId: "tx-b" });
      const list = await repo.listByPromotion(promotionId);
      expect(list).toHaveLength(2);
    });
  });
});
