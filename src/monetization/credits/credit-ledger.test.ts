/**
 * Tests for CreditLedger — including the allowNegative debit parameter (WOP-821).
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger, InsufficientBalanceError } from "./credit-ledger.js";

describe("CreditLedger core methods", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    ledger = new CreditLedger(db);
  });

  // --- credit() ---

  describe("credit()", () => {
    it("happy path: credits a tenant and returns correct transaction fields", async () => {
      const txn = await ledger.credit(
        "t1",
        Credit.fromCents(100),
        "purchase",
        "Initial deposit",
        "ref-001",
        "stripe",
        "user-abc",
      );

      expect(txn.tenantId).toBe("t1");
      expect(txn.amount.toCents()).toBe(100);
      expect(txn.balanceAfter.toCents()).toBe(100);
      expect(txn.type).toBe("purchase");
      expect(txn.description).toBe("Initial deposit");
      expect(txn.referenceId).toBe("ref-001");
      expect(txn.fundingSource).toBe("stripe");
      expect(txn.attributedUserId).toBe("user-abc");
      expect(txn.id).toBeDefined();
      expect(txn.createdAt).toBeDefined();
    });

    it("multiple credits accumulate balance correctly", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase");
      await ledger.credit("t1", Credit.fromCents(50), "promo");

      const bal = await ledger.balance("t1");
      expect(bal.toCents()).toBe(150);
    });

    it("rejects zero amount", async () => {
      await expect(ledger.credit("t1", Credit.fromCents(0), "purchase")).rejects.toThrow(
        "amount must be positive for credits",
      );
    });

    it("rejects negative amount", async () => {
      await expect(ledger.credit("t1", Credit.fromRaw(-1), "purchase")).rejects.toThrow(
        "amount must be positive for credits",
      );
    });

    it("optional fields default to null", async () => {
      const txn = await ledger.credit("t1", Credit.fromCents(10), "signup_grant");

      expect(txn.description).toBeNull();
      expect(txn.referenceId).toBeNull();
      expect(txn.fundingSource).toBeNull();
      expect(txn.attributedUserId).toBeNull();
    });
  });

  // --- balance() ---

  describe("balance()", () => {
    it("returns Credit.ZERO for a tenant with no transactions", async () => {
      const bal = await ledger.balance("nonexistent");
      expect(bal.toCents()).toBe(0);
      expect(bal.isZero()).toBe(true);
    });

    it("reflects credits and debits accurately", async () => {
      await ledger.credit("t1", Credit.fromCents(200), "purchase");
      await ledger.debit("t1", Credit.fromCents(50), "bot_runtime");

      const bal = await ledger.balance("t1");
      expect(bal.toCents()).toBe(150);
    });
  });

  // --- history() ---

  describe("history()", () => {
    it("returns transactions in reverse chronological order (newest first)", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase", "first");
      await ledger.credit("t1", Credit.fromCents(200), "promo", "second");
      await ledger.debit("t1", Credit.fromCents(50), "bot_runtime", "third");

      const hist = await ledger.history("t1");

      expect(hist).toHaveLength(3);
      // newest first
      expect(hist[0].description).toBe("third");
      expect(hist[1].description).toBe("second");
      expect(hist[2].description).toBe("first");
    });

    it("all CreditTransaction fields are populated", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase", "desc", "ref-1", "stripe", "user-1");

      const hist = await ledger.history("t1");
      expect(hist).toHaveLength(1);

      const txn = hist[0];
      expect(txn.id).toBeDefined();
      expect(txn.tenantId).toBe("t1");
      expect(txn.amount.toCents()).toBe(100);
      expect(txn.balanceAfter.toCents()).toBe(100);
      expect(txn.type).toBe("purchase");
      expect(txn.description).toBe("desc");
      expect(txn.referenceId).toBe("ref-1");
      expect(txn.fundingSource).toBe("stripe");
      expect(txn.attributedUserId).toBe("user-1");
      expect(txn.createdAt).toBeDefined();
    });

    it("respects limit and offset for pagination", async () => {
      // Insert 5 transactions
      for (let i = 1; i <= 5; i++) {
        await ledger.credit("t1", Credit.fromCents(10 * i), "purchase", `txn-${i}`);
      }

      const page1 = await ledger.history("t1", { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].description).toBe("txn-5"); // newest first
      expect(page1[1].description).toBe("txn-4");

      const page2 = await ledger.history("t1", { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      expect(page2[0].description).toBe("txn-3");
      expect(page2[1].description).toBe("txn-2");
    });

    it("filters by type when provided", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase", "buy");
      await ledger.credit("t1", Credit.fromCents(50), "promo", "free");
      await ledger.debit("t1", Credit.fromCents(10), "bot_runtime", "usage");

      const purchases = await ledger.history("t1", { type: "purchase" });
      expect(purchases).toHaveLength(1);
      expect(purchases[0].description).toBe("buy");
    });

    it("returns empty array for tenant with no transactions", async () => {
      const hist = await ledger.history("nonexistent");
      expect(hist).toEqual([]);
    });
  });

  // --- hasReferenceId() ---

  describe("hasReferenceId()", () => {
    it("returns false for a reference ID that does not exist", async () => {
      expect(await ledger.hasReferenceId("nonexistent-ref")).toBe(false);
    });

    it("returns true for a reference ID used in a credit", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase", "desc", "ref-unique");

      expect(await ledger.hasReferenceId("ref-unique")).toBe(true);
    });

    it("returns true for a reference ID used in a debit", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase");
      await ledger.debit("t1", Credit.fromCents(10), "bot_runtime", "desc", "debit-ref");

      expect(await ledger.hasReferenceId("debit-ref")).toBe(true);
    });

    it("detects reference IDs across different tenants", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase", "desc", "cross-tenant-ref");

      // hasReferenceId is global, not tenant-scoped
      expect(await ledger.hasReferenceId("cross-tenant-ref")).toBe(true);
    });
  });

  // --- tenantsWithBalance() ---

  describe("tenantsWithBalance()", () => {
    it("returns empty array when no tenants exist", async () => {
      const result = await ledger.tenantsWithBalance();
      expect(result).toEqual([]);
    });

    it("returns only tenants with positive balance", async () => {
      // t1: positive balance (100 cents)
      await ledger.credit("t1", Credit.fromCents(100), "purchase");

      // t2: zero balance (credit then debit same amount)
      await ledger.credit("t2", Credit.fromCents(50), "purchase");
      await ledger.debit("t2", Credit.fromCents(50), "bot_runtime");

      // t3: negative balance (via allowNegative)
      await ledger.credit("t3", Credit.fromCents(10), "purchase");
      await ledger.debit("t3", Credit.fromCents(20), "bot_runtime", undefined, undefined, true);

      // t4: positive balance (200 cents)
      await ledger.credit("t4", Credit.fromCents(200), "signup_grant");

      const result = await ledger.tenantsWithBalance();

      const tenantIds = result.map((r) => r.tenantId).sort();
      expect(tenantIds).toEqual(["t1", "t4"]);

      const t1 = result.find((r) => r.tenantId === "t1");
      expect(t1?.balance.toCents()).toBe(100);

      const t4 = result.find((r) => r.tenantId === "t4");
      expect(t4?.balance.toCents()).toBe(200);
    });

    it("excludes tenants with exactly zero balance", async () => {
      await ledger.credit("t1", Credit.fromCents(100), "purchase");
      await ledger.debit("t1", Credit.fromCents(100), "bot_runtime");

      const result = await ledger.tenantsWithBalance();
      expect(result).toEqual([]);
    });
  });
});

describe("CreditLedger.debit with allowNegative", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    ledger = new CreditLedger(db);
  });

  it("debit with allowNegative=false (default) throws InsufficientBalanceError when balance insufficient", async () => {
    await ledger.credit("t1", Credit.fromCents(5), "purchase", "setup");
    await expect(ledger.debit("t1", Credit.fromCents(10), "adapter_usage", "test")).rejects.toThrow(
      InsufficientBalanceError,
    );
  });

  it("debit with allowNegative=true allows negative balance", async () => {
    await ledger.credit("t1", Credit.fromCents(5), "purchase", "setup");
    const txn = await ledger.debit("t1", Credit.fromCents(10), "adapter_usage", "test", undefined, true);
    expect(txn).toBeDefined();
    expect((await ledger.balance("t1")).toCents()).toBe(-5);
  });

  it("debit with allowNegative=true records correct transaction with negative amount and negative balanceAfter", async () => {
    await ledger.credit("t1", Credit.fromCents(5), "purchase", "setup");
    const txn = await ledger.debit("t1", Credit.fromCents(10), "adapter_usage", "test", undefined, true);
    expect(txn.amount.toCents()).toBe(-10);
    expect(txn.balanceAfter.toCents()).toBe(-5);
  });
});
