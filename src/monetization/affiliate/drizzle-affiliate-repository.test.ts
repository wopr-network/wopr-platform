import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    it("is idempotent — second call with matchedAt set does not overwrite", () => {
      repo.recordReferral("referrer-1", "referred-1", "abc123");
      repo.recordMatch("referred-1", 1500);
      repo.recordMatch("referred-1", 9999);
      const list = repo.listReferrals("referrer-1");
      // First call wins; isNull(matchedAt) guard blocks the second update
      expect(list[0].matchAmountCents).toBe(1500);
    });
  });

  describe("markFirstPurchase", () => {
    it("is idempotent — second call with firstPurchaseAt set does not overwrite", () => {
      repo.recordReferral("referrer-1", "referred-1", "abc123");
      repo.markFirstPurchase("referred-1");
      const listAfterFirst = repo.listReferrals("referrer-1");
      const firstTimestamp = listAfterFirst[0].firstPurchaseAt;
      // Second call should be a no-op: isNull guard skips the update
      repo.markFirstPurchase("referred-1");
      const listAfterSecond = repo.listReferrals("referrer-1");
      expect(listAfterSecond[0].firstPurchaseAt).toBe(firstTimestamp);
    });
  });

  describe("getOrCreateCode — catch block paths", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("retries on code collision (UNIQUE on affiliate_codes.code) and returns the new code", () => {
      // Spy on db.insert: fail first call with a code collision, then delegate to real db
      let insertCallCount = 0;
      const realInsert = db.insert.bind(db);
      vi.spyOn(db, "insert").mockImplementation((table) => {
        insertCallCount++;
        if (insertCallCount === 1) {
          // Simulate code collision on first attempt
          return {
            values: () => ({
              run: () => {
                throw new Error("UNIQUE constraint failed: affiliate_codes.code");
              },
            }),
          } as unknown as ReturnType<typeof db.insert>;
        }
        return realInsert(table);
      });

      const result = repo.getOrCreateCode("tenant-retry");
      expect(result.tenantId).toBe("tenant-retry");
      expect(result.code).toMatch(/^[a-z0-9]{6}$/);
      expect(insertCallCount).toBeGreaterThanOrEqual(2);
    });

    it("recovers from tenant_id race (concurrent insert wins) by returning the existing row", () => {
      // Build a fake db that mimics the drizzle API for this specific path:
      // - First select (line 74): returns null (tenant not found yet)
      // - insert: throws UNIQUE on tenant_id (concurrent request won the race)
      // - Second select (line 110): returns the winning row
      const winnerRow = { tenantId: "tenant-race", code: "race00", createdAt: "2026-01-01T00:00:00" };
      let selectCallCount = 0;
      const fakeDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              get: () => {
                selectCallCount++;
                return selectCallCount === 1 ? undefined : winnerRow;
              },
            }),
          }),
        }),
        insert: () => ({
          values: () => ({
            run: () => {
              throw new Error("UNIQUE constraint failed: affiliate_codes.tenant_id");
            },
          }),
        }),
      } as unknown as DrizzleDb;

      const raceRepo = new DrizzleAffiliateRepository(fakeDb);
      const result = raceRepo.getOrCreateCode("tenant-race");
      expect(result.tenantId).toBe("tenant-race");
      expect(result.code).toBe("race00");
    });

    it("rethrows non-UNIQUE errors from insert", () => {
      vi.spyOn(db, "insert").mockImplementation(
        () =>
          ({
            values: () => ({
              run: () => {
                throw new Error("disk I/O error");
              },
            }),
          }) as unknown as ReturnType<typeof db.insert>,
      );

      expect(() => repo.getOrCreateCode("tenant-err")).toThrow("disk I/O error");
    });

    it("throws after exhausting all retry attempts due to persistent code collision", () => {
      // All 5 insert attempts fail with code collision; no row exists after the loop
      const fakeDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              get: () => undefined, // No row exists at any point
            }),
          }),
        }),
        insert: () => ({
          values: () => ({
            run: () => {
              throw new Error("UNIQUE constraint failed: affiliate_codes.code");
            },
          }),
        }),
      } as unknown as DrizzleDb;

      const exhaustRepo = new DrizzleAffiliateRepository(fakeDb);
      expect(() => exhaustRepo.getOrCreateCode("tenant-exhaust")).toThrow(
        "Failed to generate unique affiliate code after 5 attempts",
      );
    });
  });
});
