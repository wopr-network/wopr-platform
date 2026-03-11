import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { affiliateReferrals } from "../../db/schema/affiliate.js";
import { affiliateFraudEvents } from "../../db/schema/affiliate-fraud.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { ADMIN_BLOCK_SENTINEL, DrizzleAffiliateFraudAdminRepository } from "./affiliate-admin-repository.js";

describe("DrizzleAffiliateFraudAdminRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleAffiliateFraudAdminRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    repo = new DrizzleAffiliateFraudAdminRepository(db);
  });

  describe("listSuppressions", () => {
    it("should return fraud events ordered by createdAt desc", async () => {
      await db.insert(affiliateFraudEvents).values({
        id: "fe-1",
        referralId: "ref-1",
        referrerTenantId: "t-referrer",
        referredTenantId: "t-referred",
        verdict: "blocked",
        signals: JSON.stringify(["same_ip"]),
        signalDetails: JSON.stringify({ same_ip: "Both used 1.2.3.4" }),
        phase: "payout",
        createdAt: "2026-02-27T10:00:00Z",
      });

      const result = await repo.listSuppressions(50, 0);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].referrerTenantId).toBe("t-referrer");
      expect(result.events[0].signals).toEqual(["same_ip"]);
      expect(result.total).toBe(1);
    });

    it("should respect limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await db.insert(affiliateFraudEvents).values({
          id: `fe-${i}`,
          referralId: `ref-${i}`,
          referrerTenantId: "t-r",
          referredTenantId: `t-d-${i}`,
          verdict: "blocked",
          signals: "[]",
          signalDetails: "{}",
          phase: "payout",
          createdAt: new Date(Date.now() - i * 60000).toISOString(),
        });
      }

      const page1 = await repo.listSuppressions(2, 0);
      expect(page1.events).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await repo.listSuppressions(2, 2);
      expect(page2.events).toHaveLength(2);
    });

    it("should not return non-blocked events", async () => {
      await db.insert(affiliateFraudEvents).values({
        id: "fe-clean",
        referralId: "ref-clean",
        referrerTenantId: "t-r",
        referredTenantId: "t-d",
        verdict: "clean",
        signals: "[]",
        signalDetails: "{}",
        phase: "signup",
        createdAt: new Date().toISOString(),
      });

      const result = await repo.listSuppressions(50, 0);
      expect(result.events).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("returns fallback values when signals/signalDetails contain malformed JSON", async () => {
      await db.insert(affiliateFraudEvents).values({
        id: "fe-bad-json",
        referralId: "ref-bad",
        referrerTenantId: "t-bad",
        referredTenantId: "t-bad2",
        verdict: "blocked",
        signals: "NOT_VALID_JSON",
        signalDetails: "NOT_VALID_JSON",
        phase: "payout",
        createdAt: new Date().toISOString(),
      });

      const result = await repo.listSuppressions(50, 0);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].signals).toEqual([]);
      expect(result.events[0].signalDetails).toEqual({});
    });
  });

  describe("listVelocityReferrers", () => {
    it("should aggregate 30-day payout stats per referrer", async () => {
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        await db.insert(affiliateReferrals).values({
          id: `ar-${i}`,
          referrerTenantId: "t-r",
          referredTenantId: `t-d-${i}`,
          code: "abc123",
          matchAmountCents: 1000,
          matchedAt: new Date(now.getTime() - i * 86400000).toISOString(),
        });
      }

      const result = await repo.listVelocityReferrers(20, 20000);
      expect(result).toHaveLength(1);
      expect(result[0].referrerTenantId).toBe("t-r");
      expect(result[0].payoutCount30d).toBe(3);
      expect(result[0].payoutTotal30d).toBe(3000);
    });

    it("should exclude referrals with null matchedAt", async () => {
      await db.insert(affiliateReferrals).values({
        id: "ar-unmatched",
        referrerTenantId: "t-r",
        referredTenantId: "t-d-unmatched",
        code: "abc123",
        matchAmountCents: null,
        matchedAt: null,
      });

      const result = await repo.listVelocityReferrers(20, 20000);
      expect(result).toHaveLength(0);
    });

    it("should exclude referrals older than 30 days", async () => {
      const oldDate = new Date(Date.now() - 31 * 86400000).toISOString();
      await db.insert(affiliateReferrals).values({
        id: "ar-old",
        referrerTenantId: "t-r",
        referredTenantId: "t-d-old",
        code: "abc123",
        matchAmountCents: 1000,
        matchedAt: oldDate,
      });

      const result = await repo.listVelocityReferrers(20, 20000);
      expect(result).toHaveLength(0);
    });
  });

  describe("blockFingerprint", () => {
    it("should insert fraud events with ADMIN_BLOCK as referredTenantId", async () => {
      await db.execute(
        sql`INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at, stripe_fingerprint)
            VALUES ('ct-1', 't-alice', 0, 0, 'purchase', now(), 'fp_abc123'),
                   ('ct-2', 't-bob', 0, 0, 'purchase', now(), 'fp_abc123')`,
      );

      await repo.blockFingerprint("fp_abc123", "admin-user-1");

      const result = await repo.listSuppressions(50, 0);
      expect(result.events).toHaveLength(2);

      for (const event of result.events) {
        expect(event.referredTenantId).toBe(ADMIN_BLOCK_SENTINEL);
        expect(event.verdict).toBe("blocked");
        expect(event.phase).toBe("admin");
        expect(event.signals).toEqual(["admin_fingerprint_block"]);
      }

      const tenantIds = result.events.map((e) => e.referrerTenantId).sort();
      expect(tenantIds).toEqual(["t-alice", "t-bob"]);
    });

    it("should use unique referralId per tenant to avoid unique constraint conflicts", async () => {
      await db.execute(
        sql`INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at, stripe_fingerprint)
            VALUES ('ct-3', 't-carol', 0, 0, 'purchase', now(), 'fp_def456'),
                   ('ct-4', 't-dave', 0, 0, 'purchase', now(), 'fp_def456')`,
      );

      await repo.blockFingerprint("fp_def456", "admin-user-2");

      const result = await repo.listSuppressions(50, 0);
      expect(result.events).toHaveLength(2);
      const eventIds = result.events.map((e) => e.id);
      expect(new Set(eventIds).size).toBe(2);

      const fraudEvents = await db.select({ referralId: affiliateFraudEvents.referralId }).from(affiliateFraudEvents);
      const referralIds = fraudEvents.map((e) => e.referralId);
      expect(new Set(referralIds).size).toBe(2);
    });

    it("should be idempotent via onConflictDoNothing", async () => {
      await db.execute(
        sql`INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at, stripe_fingerprint)
            VALUES ('ct-5', 't-eve', 0, 0, 'purchase', now(), 'fp_ghi789')`,
      );

      await repo.blockFingerprint("fp_ghi789", "admin-user-3");
      await repo.blockFingerprint("fp_ghi789", "admin-user-3");

      const result = await repo.listSuppressions(50, 0);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].referredTenantId).toBe("ADMIN_BLOCK");
    });
  });
});
