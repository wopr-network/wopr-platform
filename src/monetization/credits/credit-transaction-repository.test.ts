import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { creditTransactions } from "../../db/schema/credits.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { Credit } from "../credit.js";
import { DrizzleCreditTransactionRepository } from "./credit-transaction-repository.js";

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

/** Seed a credit_transactions row directly. */
async function seedTx(opts: {
  tenantId: string;
  amount: Credit;
  type: string;
  createdAt?: string;
  referenceId?: string;
  balanceAfter?: Credit;
}): Promise<void> {
  await db.insert(creditTransactions).values({
    id: crypto.randomUUID(),
    tenantId: opts.tenantId,
    amount: opts.amount,
    balanceAfter: opts.balanceAfter ?? opts.amount,
    type: opts.type,
    description: "test",
    referenceId: opts.referenceId ?? null,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  });
}

describe("DrizzleCreditTransactionRepository", () => {
  let repo: DrizzleCreditTransactionRepository;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    repo = new DrizzleCreditTransactionRepository(db);
  });

  describe("existsByReferenceIdLike()", () => {
    it("returns false when no transactions exist", async () => {
      const result = await repo.existsByReferenceIdLike("div-%");
      expect(result).toBe(false);
    });

    it("returns true when a matching referenceId exists", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(100),
        type: "purchase",
        referenceId: "div-2026-01-01",
      });

      const result = await repo.existsByReferenceIdLike("div-%");
      expect(result).toBe(true);
    });

    it("returns false when no referenceId matches the pattern", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(100),
        type: "purchase",
        referenceId: "purchase-abc",
      });

      const result = await repo.existsByReferenceIdLike("div-%");
      expect(result).toBe(false);
    });

    it("matches partial patterns with wildcards", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(50),
        type: "community_dividend",
        referenceId: "div-2026-02-15-t1",
      });

      expect(await repo.existsByReferenceIdLike("div-2026-02-%")).toBe(true);
      expect(await repo.existsByReferenceIdLike("div-2026-03-%")).toBe(false);
    });
  });

  describe("sumPurchasesForPeriod()", () => {
    it("returns Credit.ZERO when no transactions exist", async () => {
      const sum = await repo.sumPurchasesForPeriod("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(sum.toRaw()).toBe(0);
    });

    it("sums only purchase-type transactions", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(100),
        type: "purchase",
        createdAt: "2026-01-15T12:00:00Z",
      });
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(200),
        type: "signup_grant",
        createdAt: "2026-01-15T12:00:00Z",
      });

      const sum = await repo.sumPurchasesForPeriod("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(sum.toRaw()).toBe(Credit.fromCents(100).toRaw());
    });

    it("respects half-open interval [start, end)", async () => {
      // Exactly at start — included
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(10),
        type: "purchase",
        createdAt: "2026-01-01T00:00:00Z",
      });
      // Inside window
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(20),
        type: "purchase",
        createdAt: "2026-01-15T00:00:00Z",
      });
      // Exactly at end — excluded
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(40),
        type: "purchase",
        createdAt: "2026-02-01T00:00:00Z",
      });

      const sum = await repo.sumPurchasesForPeriod("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(sum.toRaw()).toBe(Credit.fromCents(30).toRaw()); // 10 + 20, not 40
    });

    it("sums across all tenants (not tenant-scoped)", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(50),
        type: "purchase",
        createdAt: "2026-01-10T00:00:00Z",
      });
      await seedTx({
        tenantId: "t2",
        amount: Credit.fromCents(75),
        type: "purchase",
        createdAt: "2026-01-10T00:00:00Z",
      });

      const sum = await repo.sumPurchasesForPeriod("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(sum.toRaw()).toBe(Credit.fromCents(125).toRaw()); // 50 + 75
    });
  });

  describe("getActiveTenantIdsInWindow()", () => {
    it("returns empty array when no transactions exist", async () => {
      const ids = await repo.getActiveTenantIdsInWindow("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(ids).toEqual([]);
    });

    it("returns distinct tenantIds with purchase transactions in window", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(10),
        type: "purchase",
        createdAt: "2026-01-10T00:00:00Z",
      });
      // t1 again — should not duplicate
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(20),
        type: "purchase",
        createdAt: "2026-01-11T00:00:00Z",
      });
      await seedTx({
        tenantId: "t2",
        amount: Credit.fromCents(30),
        type: "purchase",
        createdAt: "2026-01-12T00:00:00Z",
      });

      const ids = await repo.getActiveTenantIdsInWindow("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(ids.sort()).toEqual(["t1", "t2"]);
    });

    it("excludes non-purchase transaction types", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(100),
        type: "signup_grant",
        createdAt: "2026-01-10T00:00:00Z",
      });

      const ids = await repo.getActiveTenantIdsInWindow("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(ids).toEqual([]);
    });

    it("respects half-open interval [start, end)", async () => {
      // Before window
      await seedTx({
        tenantId: "t-before",
        amount: Credit.fromCents(10),
        type: "purchase",
        createdAt: "2025-12-31T23:59:59Z",
      });
      // At start — included
      await seedTx({
        tenantId: "t-start",
        amount: Credit.fromCents(10),
        type: "purchase",
        createdAt: "2026-01-01T00:00:00Z",
      });
      // At end — excluded
      await seedTx({
        tenantId: "t-end",
        amount: Credit.fromCents(10),
        type: "purchase",
        createdAt: "2026-02-01T00:00:00Z",
      });

      const ids = await repo.getActiveTenantIdsInWindow("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      expect(ids).toEqual(["t-start"]);
    });
  });

  describe("referenceId uniqueness", () => {
    it("rejects duplicate referenceId (database unique constraint)", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(100),
        type: "purchase",
        referenceId: "unique-ref-1",
      });

      await expect(
        seedTx({
          tenantId: "t1",
          amount: Credit.fromCents(200),
          type: "purchase",
          referenceId: "unique-ref-1",
        }),
      ).rejects.toThrow(); // PG unique constraint violation
    });

    it("allows null referenceId on multiple rows", async () => {
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(100),
        type: "purchase",
        referenceId: undefined, // null
      });
      await seedTx({
        tenantId: "t1",
        amount: Credit.fromCents(200),
        type: "purchase",
        referenceId: undefined, // null
      });

      // Both inserted — no constraint violation for nulls
      const result = await repo.existsByReferenceIdLike("%");
      expect(result).toBe(false); // LIKE '%' won't match null referenceIds
    });
  });
});
