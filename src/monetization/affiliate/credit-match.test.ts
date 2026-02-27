import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { processAffiliateCreditMatch } from "./credit-match.js";
import { DrizzleAffiliateRepository } from "./drizzle-affiliate-repository.js";

describe("processAffiliateCreditMatch", () => {
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

  it("does nothing when tenant has no referral", async () => {
    await ledger.credit("buyer", Credit.fromCents(1000), "purchase", "first buy", "session-1", "stripe");

    const result = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(1000),
      ledger,
      affiliateRepo,
    });

    expect(result).toBeNull();
  });

  it("does nothing when tenant already has prior purchases", async () => {
    await affiliateRepo.recordReferral("referrer", "buyer", "abc123");

    await ledger.credit("buyer", Credit.fromCents(500), "purchase", "old buy", "session-0", "stripe");
    await ledger.credit("buyer", Credit.fromCents(1000), "purchase", "new buy", "session-1", "stripe");

    const result = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(1000),
      ledger,
      affiliateRepo,
    });

    expect(result).toBeNull();
  });

  it("credits referrer on first purchase with 100% match", async () => {
    await affiliateRepo.recordReferral("referrer", "buyer", "abc123");
    await ledger.credit("buyer", Credit.fromCents(2000), "purchase", "first buy", "session-1", "stripe");

    const result = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(2000),
      ledger,
      affiliateRepo,
      matchRate: 1.0,
    });

    expect(result).not.toBeNull();
    expect(result?.matchAmount.toCents()).toBe(2000);
    expect(result?.referrerTenantId).toBe("referrer");
    expect((await ledger.balance("referrer")).toCents()).toBe(2000);

    const ref = await affiliateRepo.getReferralByReferred("buyer");
    expect(ref?.matchAmount?.toCents()).toBe(2000);
    expect(ref?.matchedAt).not.toBeNull();
    expect(ref?.firstPurchaseAt).not.toBeNull();
  });

  it("respects custom match rate", async () => {
    await affiliateRepo.recordReferral("referrer", "buyer", "abc123");
    await ledger.credit("buyer", Credit.fromCents(2000), "purchase", "first buy", "session-1", "stripe");

    const result = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(2000),
      ledger,
      affiliateRepo,
      matchRate: 0.5,
    });

    expect(result?.matchAmount.toCents()).toBe(1000);
    expect((await ledger.balance("referrer")).toCents()).toBe(1000);
  });

  it("is idempotent — second call returns null", async () => {
    await affiliateRepo.recordReferral("referrer", "buyer", "abc123");
    await ledger.credit("buyer", Credit.fromCents(1000), "purchase", "first buy", "session-1", "stripe");

    const first = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(1000),
      ledger,
      affiliateRepo,
    });
    expect(first).not.toBeNull();

    const second = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(1000),
      ledger,
      affiliateRepo,
    });
    expect(second).toBeNull();
  });
});
