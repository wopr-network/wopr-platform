import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { DrizzleAffiliateRepository } from "./drizzle-affiliate-repository.js";
import { initAffiliateSchema } from "./schema.js";

describe("DrizzleAffiliateRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let repo: DrizzleAffiliateRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initAffiliateSchema(sqlite);
    db = createDb(sqlite);
    repo = new DrizzleAffiliateRepository(db);
  });

  describe("getOrCreateCode", () => {
    it("generates a 6-char alphanumeric code on first call", () => {
      const result = repo.getOrCreateCode("tenant-1");
      expect(result.tenantId).toBe("tenant-1");
      expect(result.code).toMatch(/^[a-z0-9]{6}$/);
      expect(result.createdAt).toBeTruthy();
    });

    it("returns the same code on subsequent calls", () => {
      const first = repo.getOrCreateCode("tenant-1");
      const second = repo.getOrCreateCode("tenant-1");
      expect(first.code).toBe(second.code);
    });

    it("generates different codes for different tenants", () => {
      const a = repo.getOrCreateCode("tenant-a");
      const b = repo.getOrCreateCode("tenant-b");
      expect(a.code).not.toBe(b.code);
    });
  });

  describe("getByCode", () => {
    it("returns null for unknown code", () => {
      expect(repo.getByCode("nope00")).toBeNull();
    });

    it("returns the code record for a valid code", () => {
      const created = repo.getOrCreateCode("tenant-1");
      const found = repo.getByCode(created.code);
      expect(found).not.toBeNull();
      expect(found?.tenantId).toBe("tenant-1");
    });
  });

  describe("recordReferral", () => {
    it("records a new referral and returns true", () => {
      const result = repo.recordReferral("referrer-1", "referred-1", "abc123");
      expect(result).toBe(true);
    });

    it("returns false for duplicate referred tenant (first referrer wins)", () => {
      repo.recordReferral("referrer-1", "referred-1", "abc123");
      const result = repo.recordReferral("referrer-2", "referred-1", "def456");
      expect(result).toBe(false);
    });

    it("rejects self-referral", () => {
      expect(() => repo.recordReferral("tenant-1", "tenant-1", "abc123")).toThrow("Self-referral");
    });
  });

  describe("isReferred", () => {
    it("returns false when tenant has no referral", () => {
      expect(repo.isReferred("unknown")).toBe(false);
    });

    it("returns true when tenant was referred", () => {
      repo.recordReferral("referrer-1", "referred-1", "abc123");
      expect(repo.isReferred("referred-1")).toBe(true);
    });
  });

  describe("getStats", () => {
    it("returns zeroed stats when tenant has no referrals", () => {
      repo.getOrCreateCode("tenant-1");
      const stats = repo.getStats("tenant-1");
      expect(stats.referrals_total).toBe(0);
      expect(stats.referrals_converted).toBe(0);
      expect(stats.credits_earned_cents).toBe(0);
      expect(stats.code).toMatch(/^[a-z0-9]{6}$/);
      expect(stats.link).toContain("?ref=");
    });

    it("counts referrals and conversions correctly", () => {
      const code = repo.getOrCreateCode("tenant-1");
      repo.recordReferral("tenant-1", "ref-a", code.code);
      repo.recordReferral("tenant-1", "ref-b", code.code);
      repo.markFirstPurchase("ref-a");
      repo.recordMatch("ref-a", 2000);

      const stats = repo.getStats("tenant-1");
      expect(stats.referrals_total).toBe(2);
      expect(stats.referrals_converted).toBe(1);
      expect(stats.credits_earned_cents).toBe(2000);
    });
  });

  describe("listReferrals", () => {
    it("returns empty array when no referrals", () => {
      expect(repo.listReferrals("tenant-1")).toEqual([]);
    });

    it("returns all referrals for a tenant", () => {
      repo.recordReferral("tenant-1", "ref-a", "abc123");
      repo.recordReferral("tenant-1", "ref-b", "abc123");
      const list = repo.listReferrals("tenant-1");
      expect(list).toHaveLength(2);
      expect(list[0].referredTenantId).toMatch(/ref-[ab]/);
    });
  });

  describe("markFirstPurchase", () => {
    it("sets firstPurchaseAt on the referral", () => {
      repo.recordReferral("referrer-1", "referred-1", "abc123");
      repo.markFirstPurchase("referred-1");
      const list = repo.listReferrals("referrer-1");
      expect(list[0].firstPurchaseAt).toBeTruthy();
    });
  });

  describe("recordMatch", () => {
    it("sets matchAmountCents and matchedAt", () => {
      repo.recordReferral("referrer-1", "referred-1", "abc123");
      repo.recordMatch("referred-1", 1500);
      const list = repo.listReferrals("referrer-1");
      expect(list[0].matchAmountCents).toBe(1500);
      expect(list[0].matchedAt).toBeTruthy();
    });
  });
});
