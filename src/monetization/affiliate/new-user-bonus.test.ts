import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { DrizzleAffiliateRepository } from "./drizzle-affiliate-repository.js";
import { DEFAULT_BONUS_RATE, grantNewUserBonus } from "./new-user-bonus.js";

describe("grantNewUserBonus", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;
  let affiliateRepo: DrizzleAffiliateRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
    affiliateRepo = new DrizzleAffiliateRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("DEFAULT_BONUS_RATE equals 0.20", () => {
    expect(DEFAULT_BONUS_RATE).toBe(0.2);
  });

  it("grants bonus to a referred user on first purchase", async () => {
    await affiliateRepo.getOrCreateCode("referrer-1");
    const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
    await affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    const result = await grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 5000,
    });

    expect(result).toEqual({ granted: true, bonusCents: 1000 });
    expect(await ledger.balance("referred-1")).toBe(1000);

    const txns = await ledger.history("referred-1");
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("affiliate_bonus");
    expect(txns[0].referenceId).toBe("affiliate-bonus:referred-1");
    expect(txns[0].description).toContain("first-purchase bonus");
  });

  it("skips bonus for non-referred user", async () => {
    const result = await grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "organic-user",
      purchaseAmountCents: 5000,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
    expect(await ledger.balance("organic-user")).toBe(0);
  });

  it("skips bonus if already granted (idempotency)", async () => {
    await affiliateRepo.getOrCreateCode("referrer-1");
    const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
    await affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    await grantNewUserBonus({ ledger, affiliateRepo, referredTenantId: "referred-1", purchaseAmountCents: 5000 });
    const result = await grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 10000,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
    expect(await ledger.balance("referred-1")).toBe(1000);
  });

  it("skips bonus if firstPurchaseAt is already set", async () => {
    await affiliateRepo.getOrCreateCode("referrer-1");
    const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
    await affiliateRepo.recordReferral("referrer-1", "referred-1", code);
    await affiliateRepo.markFirstPurchase("referred-1");

    const result = await grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 5000,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
  });

  it("uses custom bonus rate", async () => {
    await affiliateRepo.getOrCreateCode("referrer-1");
    const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
    await affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    const result = await grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 5000,
      bonusRate: 0.1,
    });

    expect(result).toEqual({ granted: true, bonusCents: 500 });
  });

  it("skips bonus when computed amount rounds to zero", async () => {
    await affiliateRepo.getOrCreateCode("referrer-1");
    const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
    await affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    const result = await grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 1,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
  });

  it("marks firstPurchaseAt on the referral row", async () => {
    await affiliateRepo.getOrCreateCode("referrer-1");
    const code = (await affiliateRepo.getOrCreateCode("referrer-1")).code;
    await affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    await grantNewUserBonus({ ledger, affiliateRepo, referredTenantId: "referred-1", purchaseAmountCents: 5000 });

    const referrals = await affiliateRepo.listReferrals("referrer-1");
    expect(referrals).toHaveLength(1);
    expect(referrals[0].firstPurchaseAt).not.toBeNull();
  });
});
