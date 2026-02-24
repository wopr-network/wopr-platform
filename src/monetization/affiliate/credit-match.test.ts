import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { DrizzleCreditLedger } from "../credits/credit-ledger.js";
import { initCreditSchema } from "../credits/schema.js";
import { processAffiliateCreditMatch } from "./credit-match.js";
import { DrizzleAffiliateRepository } from "./drizzle-affiliate-repository.js";
import { initAffiliateSchema } from "./schema.js";

describe("processAffiliateCreditMatch", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let ledger: DrizzleCreditLedger;
  let affiliateRepo: DrizzleAffiliateRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initCreditSchema(sqlite);
    initAffiliateSchema(sqlite);
    db = createDb(sqlite);
    ledger = new DrizzleCreditLedger(db);
    affiliateRepo = new DrizzleAffiliateRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("does nothing when tenant has no referral", () => {
    ledger.credit("buyer", 1000, "purchase", "first buy", "session-1", "stripe");

    const result = processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmountCents: 1000,
      ledger,
      affiliateRepo,
    });

    expect(result).toBeNull();
  });

  it("does nothing when tenant already has prior purchases", () => {
    affiliateRepo.recordReferral("referrer", "buyer", "abc123");

    ledger.credit("buyer", 500, "purchase", "old buy", "session-0", "stripe");
    ledger.credit("buyer", 1000, "purchase", "new buy", "session-1", "stripe");

    const result = processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmountCents: 1000,
      ledger,
      affiliateRepo,
    });

    expect(result).toBeNull();
  });

  it("credits referrer on first purchase with 100% match", () => {
    affiliateRepo.recordReferral("referrer", "buyer", "abc123");
    ledger.credit("buyer", 2000, "purchase", "first buy", "session-1", "stripe");

    const result = processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmountCents: 2000,
      ledger,
      affiliateRepo,
      matchRate: 1.0,
    });

    expect(result).not.toBeNull();
    expect(result?.matchAmountCents).toBe(2000);
    expect(result?.referrerTenantId).toBe("referrer");
    expect(ledger.balance("referrer")).toBe(2000);

    const ref = affiliateRepo.getReferralByReferred("buyer");
    expect(ref?.matchAmountCents).toBe(2000);
    expect(ref?.matchedAt).not.toBeNull();
    expect(ref?.firstPurchaseAt).not.toBeNull();
  });

  it("respects custom match rate", () => {
    affiliateRepo.recordReferral("referrer", "buyer", "abc123");
    ledger.credit("buyer", 2000, "purchase", "first buy", "session-1", "stripe");

    const result = processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmountCents: 2000,
      ledger,
      affiliateRepo,
      matchRate: 0.5,
    });

    expect(result?.matchAmountCents).toBe(1000);
    expect(ledger.balance("referrer")).toBe(1000);
  });

  it("is idempotent — second call returns null", () => {
    affiliateRepo.recordReferral("referrer", "buyer", "abc123");
    ledger.credit("buyer", 1000, "purchase", "first buy", "session-1", "stripe");

    const first = processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmountCents: 1000,
      ledger,
      affiliateRepo,
    });
    expect(first).not.toBeNull();

    const second = processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmountCents: 1000,
      ledger,
      affiliateRepo,
    });
    expect(second).toBeNull();
  });
});
