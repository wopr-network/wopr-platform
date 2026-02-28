import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { DrizzleAffiliateFraudRepository } from "./affiliate-fraud-repository.js";
import { processAffiliateCreditMatch } from "./credit-match.js";
import { DrizzleAffiliateRepository } from "./drizzle-affiliate-repository.js";

describe("processAffiliateCreditMatch", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;
  let affiliateRepo: DrizzleAffiliateRepository;
  let fraudRepo: DrizzleAffiliateFraudRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
    affiliateRepo = new DrizzleAffiliateRepository(db);
    fraudRepo = new DrizzleAffiliateFraudRepository(db);
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

  it("suppresses payout when fraud detector returns blocked", async () => {
    await affiliateRepo.recordReferral("referrer", "buyer", "abc123", {
      signupIp: "1.2.3.4",
      signupEmail: "alice+ref@gmail.com",
    });
    await ledger.credit("buyer", Credit.fromCents(2000), "purchase", "first buy", "session-1", "stripe");

    const result = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(2000),
      ledger,
      affiliateRepo,
      fraudRepo,
      referrerIp: "1.2.3.4",
      referrerEmail: "alice@gmail.com",
      referrerStripeCustomerId: null,
      referredStripeCustomerId: null,
    });

    expect(result).toBeNull();
    expect((await ledger.balance("referrer")).toCents()).toBe(0);

    const events = await fraudRepo.listByReferrer("referrer");
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("blocked");
    expect(events[0].phase).toBe("payout");
  });

  describe("velocity caps", () => {
    it("suppresses payout when referrer hits referral count cap", async () => {
      // Set up 20 existing matched referrals for the referrer
      for (let i = 0; i < 20; i++) {
        await affiliateRepo.recordReferral("referrer", `old-buyer-${i}`, "abc123");
        await affiliateRepo.recordMatch(`old-buyer-${i}`, Credit.fromCents(500));
      }

      // New referral
      await affiliateRepo.recordReferral("referrer", "buyer", "abc123");
      await ledger.credit("buyer", Credit.fromCents(1000), "purchase", "first buy", "session-1", "stripe");

      const result = await processAffiliateCreditMatch({
        tenantId: "buyer",
        purchaseAmount: Credit.fromCents(1000),
        ledger,
        affiliateRepo,
        maxReferrals30d: 20,
      });

      expect(result).toBeNull();
      // Referrer should NOT have been credited
      expect((await ledger.balance("referrer")).toCents()).toBe(0);
      // Referral should be marked as suppressed
      const ref = await affiliateRepo.getReferralByReferred("buyer");
      expect(ref?.payoutSuppressed).toBe(true);
      expect(ref?.suppressionReason).toBe("velocity_cap_referrals");
    });

    it("suppresses payout when referrer hits credit total cap", async () => {
      // Set up referrals totaling 20000 cents ($200)
      for (let i = 0; i < 4; i++) {
        await affiliateRepo.recordReferral("referrer", `old-buyer-${i}`, "abc123");
        await affiliateRepo.recordMatch(`old-buyer-${i}`, Credit.fromCents(5000));
      }

      // New referral
      await affiliateRepo.recordReferral("referrer", "buyer", "abc123");
      await ledger.credit("buyer", Credit.fromCents(1000), "purchase", "first buy", "session-1", "stripe");

      const result = await processAffiliateCreditMatch({
        tenantId: "buyer",
        purchaseAmount: Credit.fromCents(1000),
        ledger,
        affiliateRepo,
        maxMatchCredits30d: 20000,
      });

      expect(result).toBeNull();
      expect((await ledger.balance("referrer")).toCents()).toBe(0);
      const ref = await affiliateRepo.getReferralByReferred("buyer");
      expect(ref?.payoutSuppressed).toBe(true);
      expect(ref?.suppressionReason).toBe("velocity_cap_credits");
    });

    it("allows payout when under both caps", async () => {
      await affiliateRepo.recordReferral("referrer", "buyer", "abc123");
      await ledger.credit("buyer", Credit.fromCents(2000), "purchase", "first buy", "session-1", "stripe");

      const result = await processAffiliateCreditMatch({
        tenantId: "buyer",
        purchaseAmount: Credit.fromCents(2000),
        ledger,
        affiliateRepo,
        maxReferrals30d: 20,
        maxMatchCredits30d: 20000,
      });

      expect(result).not.toBeNull();
      expect(result?.matchAmount.toCents()).toBe(2000);
    });
  });

  it("allows payout but logs fraud event when single signal detected", async () => {
    await affiliateRepo.recordReferral("referrer", "buyer", "abc123", {
      signupIp: "1.2.3.4",
    });
    await ledger.credit("buyer", Credit.fromCents(2000), "purchase", "first buy", "session-1", "stripe");

    const result = await processAffiliateCreditMatch({
      tenantId: "buyer",
      purchaseAmount: Credit.fromCents(2000),
      ledger,
      affiliateRepo,
      fraudRepo,
      referrerIp: "1.2.3.4",
      referrerEmail: null,
      referrerStripeCustomerId: null,
      referredStripeCustomerId: null,
    });

    // Flagged but NOT blocked — payout still goes through
    expect(result).not.toBeNull();
    expect(result?.matchAmount.toCents()).toBe(2000);

    // But a fraud event was logged
    const events = await fraudRepo.listByReferrer("referrer");
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("flagged");
  });
});
