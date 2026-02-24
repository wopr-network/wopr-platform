import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { initCreditSchema } from "../credits/schema.js";
import { DrizzleAffiliateRepository } from "./drizzle-affiliate-repository.js";
import { DEFAULT_BONUS_RATE, grantNewUserBonus } from "./new-user-bonus.js";
import { initAffiliateSchema } from "./schema.js";

describe("grantNewUserBonus", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let ledger: CreditLedger;
  let affiliateRepo: DrizzleAffiliateRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initCreditSchema(sqlite);
    initAffiliateSchema(sqlite);
    db = createDb(sqlite);
    ledger = new CreditLedger(db);
    affiliateRepo = new DrizzleAffiliateRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("DEFAULT_BONUS_RATE equals 0.20", () => {
    expect(DEFAULT_BONUS_RATE).toBe(0.2);
  });

  it("grants bonus to a referred user on first purchase", () => {
    affiliateRepo.getOrCreateCode("referrer-1");
    const code = affiliateRepo.getOrCreateCode("referrer-1").code;
    affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    const result = grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 5000,
    });

    expect(result).toEqual({ granted: true, bonusCents: 1000 });
    expect(ledger.balance("referred-1")).toBe(1000);

    const txns = ledger.history("referred-1");
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("affiliate_bonus");
    expect(txns[0].referenceId).toBe("affiliate-bonus:referred-1");
    expect(txns[0].description).toContain("first-purchase bonus");
  });

  it("skips bonus for non-referred user", () => {
    const result = grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "organic-user",
      purchaseAmountCents: 5000,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
    expect(ledger.balance("organic-user")).toBe(0);
  });

  it("skips bonus if already granted (idempotency)", () => {
    affiliateRepo.getOrCreateCode("referrer-1");
    const code = affiliateRepo.getOrCreateCode("referrer-1").code;
    affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    grantNewUserBonus({ ledger, affiliateRepo, referredTenantId: "referred-1", purchaseAmountCents: 5000 });
    const result = grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 10000,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
    expect(ledger.balance("referred-1")).toBe(1000);
  });

  it("skips bonus if firstPurchaseAt is already set", () => {
    affiliateRepo.getOrCreateCode("referrer-1");
    const code = affiliateRepo.getOrCreateCode("referrer-1").code;
    affiliateRepo.recordReferral("referrer-1", "referred-1", code);
    affiliateRepo.markFirstPurchase("referred-1");

    const result = grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 5000,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
  });

  it("uses custom bonus rate", () => {
    affiliateRepo.getOrCreateCode("referrer-1");
    const code = affiliateRepo.getOrCreateCode("referrer-1").code;
    affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    const result = grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 5000,
      bonusRate: 0.1,
    });

    expect(result).toEqual({ granted: true, bonusCents: 500 });
  });

  it("skips bonus when computed amount rounds to zero", () => {
    affiliateRepo.getOrCreateCode("referrer-1");
    const code = affiliateRepo.getOrCreateCode("referrer-1").code;
    affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    const result = grantNewUserBonus({
      ledger,
      affiliateRepo,
      referredTenantId: "referred-1",
      purchaseAmountCents: 1,
    });

    expect(result).toEqual({ granted: false, bonusCents: 0 });
  });

  it("marks firstPurchaseAt on the referral row", () => {
    affiliateRepo.getOrCreateCode("referrer-1");
    const code = affiliateRepo.getOrCreateCode("referrer-1").code;
    affiliateRepo.recordReferral("referrer-1", "referred-1", code);

    grantNewUserBonus({ ledger, affiliateRepo, referredTenantId: "referred-1", purchaseAmountCents: 5000 });

    const referrals = affiliateRepo.listReferrals("referrer-1");
    expect(referrals).toHaveLength(1);
    expect(referrals[0].firstPurchaseAt).not.toBeNull();
  });
});
