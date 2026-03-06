import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction } from "../../src/test/db.js";
import { Credit } from "../../src/monetization/credit.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { DrizzleAffiliateFraudRepository } from "../../src/monetization/affiliate/affiliate-fraud-repository.js";
import { processAffiliateCreditMatch } from "../../src/monetization/affiliate/credit-match.js";
import { DrizzleAffiliateRepository } from "../../src/monetization/affiliate/drizzle-affiliate-repository.js";
import { grantNewUserBonus } from "../../src/monetization/affiliate/new-user-bonus.js";

describe("affiliate credit-match e2e", () => {
	let pool: PGlite;
	let db: DrizzleDb;
	let ledger: CreditLedger;
	let affiliateRepo: DrizzleAffiliateRepository;
	let fraudRepo: DrizzleAffiliateFraudRepository;

	beforeEach(async () => {
		({ db, pool } = await createTestDb());
		await beginTestTransaction(pool);
		ledger = new CreditLedger(db);
		affiliateRepo = new DrizzleAffiliateRepository(db);
		fraudRepo = new DrizzleAffiliateFraudRepository(db);
	});

	afterEach(async () => {
		await endTestTransaction(pool);
		await pool.close();
	});

	it("happy path — referrer gets commission (matchRate × purchase)", async () => {
		await affiliateRepo.recordReferral("referrer-1", "buyer-1", "CODE01");
		await ledger.credit("buyer-1", Credit.fromCents(5000), "purchase", "first buy", "session-1", "stripe");

		const result = await processAffiliateCreditMatch({
			tenantId: "buyer-1",
			purchaseAmount: Credit.fromCents(5000),
			ledger,
			affiliateRepo,
			fraudRepo,
			matchRate: 1.0,
			referrerIp: null,
			referrerEmail: null,
			referrerStripeCustomerId: null,
			referredStripeCustomerId: null,
		});

		expect(result).not.toBeNull();
		expect(result!.referrerTenantId).toBe("referrer-1");
		expect(result!.matchAmount.toCents()).toBe(5000);
		expect((await ledger.balance("referrer-1")).toCents()).toBe(5000);

		const ref = await affiliateRepo.getReferralByReferred("buyer-1");
		expect(ref?.matchedAt).not.toBeNull();
		expect(ref?.matchAmount?.toCents()).toBe(5000);
		expect(ref?.firstPurchaseAt).not.toBeNull();
	});

	it("self-referral blocked — same IP + email alias detected, no commission", async () => {
		await affiliateRepo.recordReferral("referrer-2", "buyer-2", "CODE02", {
			signupIp: "10.0.0.1",
			signupEmail: "alice+ref@gmail.com",
		});
		await ledger.credit("buyer-2", Credit.fromCents(3000), "purchase", "first buy", "session-2", "stripe");

		const result = await processAffiliateCreditMatch({
			tenantId: "buyer-2",
			purchaseAmount: Credit.fromCents(3000),
			ledger,
			affiliateRepo,
			fraudRepo,
			matchRate: 1.0,
			referrerIp: "10.0.0.1",
			referrerEmail: "alice@gmail.com",
			referrerStripeCustomerId: null,
			referredStripeCustomerId: null,
		});

		expect(result).toBeNull();
		expect((await ledger.balance("referrer-2")).toCents()).toBe(0);

		const events = await fraudRepo.listByReferrer("referrer-2");
		expect(events).toHaveLength(1);
		expect(events[0].verdict).toBe("blocked");
		expect(events[0].phase).toBe("payout");
		expect(events[0].signals).toContain("same_ip");
		expect(events[0].signals).toContain("email_alias");
	});

	it("velocity cap — max referrals in 30 days exceeded, commission rejected", async () => {
		for (let i = 0; i < 5; i++) {
			await affiliateRepo.recordReferral("referrer-3", `old-buyer-${i}`, "CODE03");
			await affiliateRepo.recordMatch(`old-buyer-${i}`, Credit.fromCents(1000));
		}

		await affiliateRepo.recordReferral("referrer-3", "buyer-3", "CODE03");
		await ledger.credit("buyer-3", Credit.fromCents(2000), "purchase", "first buy", "session-3", "stripe");

		const result = await processAffiliateCreditMatch({
			tenantId: "buyer-3",
			purchaseAmount: Credit.fromCents(2000),
			ledger,
			affiliateRepo,
			matchRate: 1.0,
			maxReferrals30d: 5,
		});

		expect(result).toBeNull();
		expect((await ledger.balance("referrer-3")).toCents()).toBe(0);

		const ref = await affiliateRepo.getReferralByReferred("buyer-3");
		expect(ref?.payoutSuppressed).toBe(true);
		expect(ref?.suppressionReason).toBe("velocity_cap_referrals");
		expect(ref?.firstPurchaseAt).not.toBeNull();
	});

	it("velocity cap — max credits cap exceeded, commission suppressed", async () => {
		for (let i = 0; i < 4; i++) {
			await affiliateRepo.recordReferral("referrer-4", `old-buyer-${i}`, "CODE04");
			await affiliateRepo.recordMatch(`old-buyer-${i}`, Credit.fromCents(5000));
		}

		await affiliateRepo.recordReferral("referrer-4", "buyer-4", "CODE04");
		await ledger.credit("buyer-4", Credit.fromCents(1000), "purchase", "first buy", "session-4", "stripe");

		const result = await processAffiliateCreditMatch({
			tenantId: "buyer-4",
			purchaseAmount: Credit.fromCents(1000),
			ledger,
			affiliateRepo,
			matchRate: 1.0,
			maxMatchCredits30d: 20000,
			maxReferrals30d: 100,
		});

		expect(result).toBeNull();
		expect((await ledger.balance("referrer-4")).toCents()).toBe(0);

		const ref = await affiliateRepo.getReferralByReferred("buyer-4");
		expect(ref?.payoutSuppressed).toBe(true);
		expect(ref?.suppressionReason).toBe("velocity_cap_credits");
		expect(ref?.firstPurchaseAt).not.toBeNull();
	});

	it("new user bonus — referred user gets 20% on first purchase, idempotent on second", async () => {
		await affiliateRepo.recordReferral("referrer-5", "buyer-5", "CODE05");

		const first = await grantNewUserBonus({
			ledger,
			affiliateRepo,
			referredTenantId: "buyer-5",
			purchaseAmount: Credit.fromCents(10000),
			bonusRate: 0.2,
		});

		expect(first.granted).toBe(true);
		expect(first.bonus.toCents()).toBe(2000);
		expect((await ledger.balance("buyer-5")).toCents()).toBe(2000);

		const ref = await affiliateRepo.getReferralByReferred("buyer-5");
		expect(ref?.firstPurchaseAt).not.toBeNull();

		const second = await grantNewUserBonus({
			ledger,
			affiliateRepo,
			referredTenantId: "buyer-5",
			purchaseAmount: Credit.fromCents(10000),
			bonusRate: 0.2,
		});

		expect(second.granted).toBe(false);
		expect(second.bonus.toCents()).toBe(0);
		expect((await ledger.balance("buyer-5")).toCents()).toBe(2000);
	});
});
