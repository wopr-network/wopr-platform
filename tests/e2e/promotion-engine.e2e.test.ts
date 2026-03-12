import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@wopr-network/platform-core/test/db";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { CreditLedger } from "@wopr-network/platform-core";
import { Credit } from "@wopr-network/platform-core";
import { DrizzlePromotionRepository } from "@wopr-network/platform-core/monetization/promotions/promotion-repository";
import { DrizzleCouponRepository } from "@wopr-network/platform-core/monetization/promotions/coupon-repository";
import { DrizzleRedemptionRepository } from "@wopr-network/platform-core/monetization/promotions/redemption-repository";
import { PromotionEngine } from "@wopr-network/platform-core/monetization/promotions/engine";

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("E2E: promotion engine — coupons, purchase-triggered promos, limits", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let promotionRepo: DrizzlePromotionRepository;
  let couponRepo: DrizzleCouponRepository;
  let redemptionRepo: DrizzleRedemptionRepository;
  let engine: PromotionEngine;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
    promotionRepo = new DrizzlePromotionRepository(db);
    couponRepo = new DrizzleCouponRepository(db);
    redemptionRepo = new DrizzleRedemptionRepository(db);
    engine = new PromotionEngine({
      promotionRepo,
      couponRepo,
      redemptionRepo,
      ledger,
    });
  });

  afterEach(async () => {
    await pool?.close();
  });

  it("coupon redemption — happy path: grants credits and records redemption", async () => {
    const tenantId = `tenant-${randomUUID()}`;

    const promo = await promotionRepo.create({
      name: "Launch Coupon",
      type: "coupon_fixed",
      status: "active",
      valueType: "flat_credits",
      valueAmount: 500,
      totalUseLimit: 100,
      perUserLimit: 1,
      couponCode: "LAUNCH50",
      createdBy: "admin",
    });

    const results = await engine.evaluateAndGrant({
      tenantId,
      trigger: "coupon_redeem",
      couponCode: "LAUNCH50",
    });

    expect(results).toHaveLength(1);
    expect(results[0].creditsGranted.toCents()).toBe(500);
    expect(results[0].promotionId).toBe(promo.id);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500);

    const history = await ledger.history(tenantId);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("promo");

    const count = await redemptionRepo.countByTenant(promo.id, tenantId);
    expect(count).toBe(1);
  });

  it("coupon — max redemptions enforced (totalUseLimit)", async () => {
    const tenantA = `tenant-a-${randomUUID()}`;
    const tenantB = `tenant-b-${randomUUID()}`;

    await promotionRepo.create({
      name: "One-Time Coupon",
      type: "coupon_fixed",
      status: "active",
      valueType: "flat_credits",
      valueAmount: 300,
      totalUseLimit: 1,
      perUserLimit: 1,
      couponCode: "ONEUSE",
      createdBy: "admin",
    });

    const resultsA = await engine.evaluateAndGrant({
      tenantId: tenantA,
      trigger: "coupon_redeem",
      couponCode: "ONEUSE",
    });
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].creditsGranted.toCents()).toBe(300);

    const resultsB = await engine.evaluateAndGrant({
      tenantId: tenantB,
      trigger: "coupon_redeem",
      couponCode: "ONEUSE",
    });
    expect(resultsB).toHaveLength(0);

    const balanceB = await ledger.balance(tenantB);
    expect(balanceB.toCents()).toBe(0);
  });

  it("coupon — single-use per tenant (perUserLimit)", async () => {
    const tenantId = `tenant-${randomUUID()}`;

    await promotionRepo.create({
      name: "Single Use Per User",
      type: "coupon_fixed",
      status: "active",
      valueType: "flat_credits",
      valueAmount: 200,
      totalUseLimit: 1000,
      perUserLimit: 1,
      couponCode: "SINGLEUSE",
      createdBy: "admin",
    });

    const results1 = await engine.evaluateAndGrant({
      tenantId,
      trigger: "coupon_redeem",
      couponCode: "SINGLEUSE",
    });
    expect(results1).toHaveLength(1);

    const results2 = await engine.evaluateAndGrant({
      tenantId,
      trigger: "coupon_redeem",
      couponCode: "SINGLEUSE",
    });
    expect(results2).toHaveLength(0);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(200);
  });

  it("purchase-triggered promotion — spend $50, get $5 bonus", async () => {
    const tenantId = `tenant-${randomUUID()}`;

    await promotionRepo.create({
      name: "Spend $50 Get $5",
      type: "bonus_on_purchase",
      status: "active",
      valueType: "flat_credits",
      valueAmount: 500,
      minPurchaseCredits: 5000,
      perUserLimit: 1,
      createdBy: "admin",
    });

    const results = await engine.evaluateAndGrant({
      tenantId,
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(5000),
    });

    expect(results).toHaveLength(1);
    expect(results[0].creditsGranted.toCents()).toBe(500);
    expect(results[0].promotionName).toBe("Spend $50 Get $5");

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500);
  });

  it("expired promotion — no credits granted", async () => {
    const tenantId = `tenant-${randomUUID()}`;

    const pastDate = new Date(Date.now() - 86_400_000);
    await promotionRepo.create({
      name: "Expired Promo",
      type: "bonus_on_purchase",
      status: "active",
      valueType: "flat_credits",
      valueAmount: 1000,
      endsAt: pastDate,
      perUserLimit: 1,
      createdBy: "admin",
    });

    const results = await engine.evaluateAndGrant({
      tenantId,
      trigger: "purchase",
      purchaseAmountCredits: Credit.fromCents(5000),
    });

    expect(results).toHaveLength(0);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(0);
  });
});
