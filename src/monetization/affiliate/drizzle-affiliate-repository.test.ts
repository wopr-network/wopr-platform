import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { DrizzleAffiliateRepository } from "./drizzle-affiliate-repository.js";

describe("DrizzleAffiliateRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleAffiliateRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleAffiliateRepository(db);
  });

  describe("getOrCreateCode", () => {
    it("generates a 6-char alphanumeric code on first call", async () => {
      const result = await repo.getOrCreateCode("tenant-1");
      expect(result.tenantId).toBe("tenant-1");
      expect(result.code).toMatch(/^[a-z0-9]{6}$/);
      expect(result.createdAt).toBeTruthy();
    });

    it("returns the same code on subsequent calls", async () => {
      const first = await repo.getOrCreateCode("tenant-1");
      const second = await repo.getOrCreateCode("tenant-1");
      expect(first.code).toBe(second.code);
    });

    it("generates different codes for different tenants", async () => {
      const a = await repo.getOrCreateCode("tenant-a");
      const b = await repo.getOrCreateCode("tenant-b");
      expect(a.code).not.toBe(b.code);
    });
  });

  describe("getByCode", () => {
    it("returns null for unknown code", async () => {
      expect(await repo.getByCode("nope00")).toBeNull();
    });

    it("returns the code record for a valid code", async () => {
      const created = await repo.getOrCreateCode("tenant-1");
      const found = await repo.getByCode(created.code);
      expect(found).not.toBeNull();
      expect(found?.tenantId).toBe("tenant-1");
    });
  });

  describe("recordReferral", () => {
    it("records a new referral and returns true", async () => {
      const result = await repo.recordReferral("referrer-1", "referred-1", "abc123");
      expect(result).toBe(true);
    });

    it("returns false for duplicate referred tenant (first referrer wins)", async () => {
      await repo.recordReferral("referrer-1", "referred-1", "abc123");
      const result = await repo.recordReferral("referrer-2", "referred-1", "def456");
      expect(result).toBe(false);
    });

    it("rejects self-referral", async () => {
      await expect(repo.recordReferral("tenant-1", "tenant-1", "abc123")).rejects.toThrow("Self-referral");
    });
  });

  describe("isReferred", () => {
    it("returns false when tenant has no referral", async () => {
      expect(await repo.isReferred("unknown")).toBe(false);
    });

    it("returns true when tenant was referred", async () => {
      await repo.recordReferral("referrer-1", "referred-1", "abc123");
      expect(await repo.isReferred("referred-1")).toBe(true);
    });
  });

  describe("getStats", () => {
    it("returns zeroed stats when tenant has no referrals", async () => {
      await repo.getOrCreateCode("tenant-1");
      const stats = await repo.getStats("tenant-1");
      expect(stats.referrals_total).toBe(0);
      expect(stats.referrals_converted).toBe(0);
      expect(stats.creditsEarned.toCents()).toBe(0);
      expect(stats.code).toMatch(/^[a-z0-9]{6}$/);
      expect(stats.link).toContain("?ref=");
    });

    it("counts referrals and conversions correctly", async () => {
      const code = await repo.getOrCreateCode("tenant-1");
      await repo.recordReferral("tenant-1", "ref-a", code.code);
      await repo.recordReferral("tenant-1", "ref-b", code.code);
      await repo.markFirstPurchase("ref-a");
      await repo.recordMatch("ref-a", Credit.fromCents(2000));

      const stats = await repo.getStats("tenant-1");
      expect(stats.referrals_total).toBe(2);
      expect(stats.referrals_converted).toBe(1);
      expect(stats.creditsEarned.toCents()).toBe(2000);
    });
  });

  describe("listReferrals", () => {
    it("returns empty array when no referrals", async () => {
      expect(await repo.listReferrals("tenant-1")).toEqual([]);
    });

    it("returns all referrals for a tenant", async () => {
      await repo.recordReferral("tenant-1", "ref-a", "abc123");
      await repo.recordReferral("tenant-1", "ref-b", "abc123");
      const list = await repo.listReferrals("tenant-1");
      expect(list).toHaveLength(2);
      expect(list[0].referredTenantId).toMatch(/ref-[ab]/);
    });
  });

  describe("markFirstPurchase", () => {
    it("sets firstPurchaseAt on the referral", async () => {
      await repo.recordReferral("referrer-1", "referred-1", "abc123");
      await repo.markFirstPurchase("referred-1");
      const list = await repo.listReferrals("referrer-1");
      expect(list[0].firstPurchaseAt).toBeTruthy();
    });
  });

  describe("recordMatch", () => {
    it("sets matchAmountCents and matchedAt", async () => {
      await repo.recordReferral("referrer-1", "referred-1", "abc123");
      await repo.recordMatch("referred-1", Credit.fromCents(1500));
      const list = await repo.listReferrals("referrer-1");
      expect(list[0].matchAmount?.toCents()).toBe(1500);
      expect(list[0].matchedAt).toBeTruthy();
    });

    it("is idempotent — second call with matchedAt set does not overwrite", async () => {
      await repo.recordReferral("referrer-1", "referred-1", "abc123");
      await repo.recordMatch("referred-1", Credit.fromCents(1500));
      await repo.recordMatch("referred-1", Credit.fromCents(9999));
      const list = await repo.listReferrals("referrer-1");
      // First call wins; isNull(matchedAt) guard blocks the second update
      expect(list[0].matchAmount?.toCents()).toBe(1500);
    });
  });

  describe("markFirstPurchase (idempotent)", () => {
    it("is idempotent — second call with firstPurchaseAt set does not overwrite", async () => {
      await repo.recordReferral("referrer-1", "referred-1", "abc123");
      await repo.markFirstPurchase("referred-1");
      const listAfterFirst = await repo.listReferrals("referrer-1");
      const firstTimestamp = listAfterFirst[0].firstPurchaseAt;
      // Second call should be a no-op: isNull guard skips the update
      await repo.markFirstPurchase("referred-1");
      const listAfterSecond = await repo.listReferrals("referrer-1");
      expect(listAfterSecond[0].firstPurchaseAt).toBe(firstTimestamp);
    });
  });

  describe("getReferralByReferred", () => {
    it("returns null when no referral exists", async () => {
      expect(await repo.getReferralByReferred("unknown")).toBeNull();
    });

    it("returns the referral for a referred tenant", async () => {
      await repo.recordReferral("referrer-1", "referred-1", "abc123");
      const ref = await repo.getReferralByReferred("referred-1");
      expect(ref).not.toBeNull();
      expect(ref?.referrerTenantId).toBe("referrer-1");
      expect(ref?.referredTenantId).toBe("referred-1");
      expect(ref?.code).toBe("abc123");
      expect(ref?.firstPurchaseAt).toBeNull();
      expect(ref?.matchAmount).toBeNull();
      expect(ref?.matchedAt).toBeNull();
    });
  });

  describe("velocity cap queries", () => {
    it("getPayoutCount30d returns 0 when no payouts", async () => {
      const count = await repo.getPayoutCount30d("referrer");
      expect(count).toBe(0);
    });

    it("getPayoutCount30d counts only non-suppressed payouts in last 30 days", async () => {
      // Create referrer code
      await repo.getOrCreateCode("referrer");

      // Record 3 referrals with matches
      for (let i = 0; i < 3; i++) {
        await repo.recordReferral("referrer", `buyer-${i}`, "abc123");
        await repo.recordMatch(`buyer-${i}`, 1000);
      }

      // Record 1 suppressed referral
      await repo.recordReferral("referrer", "buyer-suppressed", "abc123");
      await repo.recordSuppression("buyer-suppressed", "velocity_cap_referrals");

      const count = await repo.getPayoutCount30d("referrer");
      expect(count).toBe(3); // excludes suppressed
    });

    it("getPayoutTotal30d sums only non-suppressed payouts in last 30 days", async () => {
      await repo.getOrCreateCode("referrer");

      await repo.recordReferral("referrer", "buyer-0", "abc123");
      await repo.recordMatch("buyer-0", 5000);

      await repo.recordReferral("referrer", "buyer-1", "abc123");
      await repo.recordMatch("buyer-1", 3000);

      const total = await repo.getPayoutTotal30d("referrer");
      expect(total).toBe(8000);
    });

    it("recordSuppression marks referral as suppressed with reason", async () => {
      await repo.getOrCreateCode("referrer");
      await repo.recordReferral("referrer", "buyer", "abc123");

      await repo.recordSuppression("buyer", "velocity_cap_credits");

      const ref = await repo.getReferralByReferred("buyer");
      expect(ref?.payoutSuppressed).toBe(true);
      expect(ref?.suppressionReason).toBe("velocity_cap_credits");
    });
  });

  describe("getOrCreateCode — catch block paths", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("retries on code collision (UNIQUE on affiliate_codes.code) and returns the new code", async () => {
      // Spy on db.insert: fail first call with a code collision, then delegate to real db
      let insertCallCount = 0;
      const realInsert = db.insert.bind(db);
      vi.spyOn(db, "insert").mockImplementation((table) => {
        insertCallCount++;
        if (insertCallCount === 1) {
          // Simulate code collision on first attempt
          return {
            values: () => Promise.reject(new Error("UNIQUE constraint failed: affiliate_codes.code")),
          } as unknown as ReturnType<typeof db.insert>;
        }
        return realInsert(table);
      });

      const result = await repo.getOrCreateCode("tenant-retry");
      expect(result.tenantId).toBe("tenant-retry");
      expect(result.code).toMatch(/^[a-z0-9]{6}$/);
      expect(insertCallCount).toBeGreaterThanOrEqual(2);
    });

    it("rethrows non-UNIQUE errors from insert", async () => {
      vi.spyOn(db, "insert").mockImplementation(
        () =>
          ({
            values: () => Promise.reject(new Error("disk I/O error")),
          }) as unknown as ReturnType<typeof db.insert>,
      );

      await expect(repo.getOrCreateCode("tenant-err")).rejects.toThrow("disk I/O error");
    });

    it("throws after exhausting all retry attempts due to persistent code collision", async () => {
      // All 5 insert attempts fail with code collision
      vi.spyOn(db, "insert").mockImplementation(
        () =>
          ({
            values: () => Promise.reject(new Error("UNIQUE constraint failed: affiliate_codes.code")),
          }) as unknown as ReturnType<typeof db.insert>,
      );
      // Mock select to always return empty (no existing row)
      vi.spyOn(db, "select").mockImplementation(
        () =>
          ({
            from: () => ({
              where: () => Promise.resolve([]),
            }),
          }) as unknown as ReturnType<typeof db.select>,
      );

      await expect(repo.getOrCreateCode("tenant-exhaust")).rejects.toThrow(
        "Failed to generate unique affiliate code after 5 attempts",
      );
    });
  });
});
