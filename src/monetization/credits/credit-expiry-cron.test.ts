import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { runCreditExpiryCron } from "./credit-expiry-cron.js";
import { DrizzleCreditLedger } from "./credit-ledger.js";

describe("runCreditExpiryCron", () => {
  let pool: PGlite;
  let ledger: DrizzleCreditLedger;

  beforeAll(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    ledger = new DrizzleCreditLedger(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  // All tests pass an explicit `now` parameter — hardcoded dates are time-independent
  // because runCreditExpiryCron never reads the system clock.
  it("returns empty result when no expired credits exist", async () => {
    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result.processed).toBe(0);
    expect(result.expired).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("debits expired promotional credit grant", async () => {
    await ledger.credit(
      "tenant-1",
      Credit.fromCents(500),
      "promo",
      "New user bonus",
      "promo:tenant-1",
      undefined,
      undefined,
      "2026-01-10T00:00:00Z",
    );

    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result.processed).toBe(1);
    expect(result.expired).toContain("tenant-1");

    const balance = await ledger.balance("tenant-1");
    expect(balance.toCents()).toBe(0);
  });

  it("does not debit non-expired credits", async () => {
    await ledger.credit(
      "tenant-1",
      Credit.fromCents(500),
      "promo",
      "Future bonus",
      "promo:tenant-1-future",
      undefined,
      undefined,
      "2026-02-01T00:00:00Z",
    );

    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result.processed).toBe(0);

    const balance = await ledger.balance("tenant-1");
    expect(balance.toCents()).toBe(500);
  });

  it("does not debit credits without expires_at", async () => {
    await ledger.credit("tenant-1", Credit.fromCents(500), "purchase", "Top-up");

    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result.processed).toBe(0);

    const balance = await ledger.balance("tenant-1");
    expect(balance.toCents()).toBe(500);
  });

  it("only debits up to available balance when partially consumed", async () => {
    await ledger.credit(
      "tenant-1",
      Credit.fromCents(500),
      "promo",
      "Promo",
      "promo:partial",
      undefined,
      undefined,
      "2026-01-10T00:00:00Z",
    );
    await ledger.debit("tenant-1", Credit.fromCents(300), "bot_runtime", "Runtime");

    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result.processed).toBe(1);

    const balance = await ledger.balance("tenant-1");
    expect(balance.toCents()).toBe(0);
  });

  it("is idempotent -- does not double-debit on second run", async () => {
    await ledger.credit(
      "tenant-1",
      Credit.fromCents(500),
      "promo",
      "Promo",
      "promo:idemp",
      undefined,
      undefined,
      "2026-01-10T00:00:00Z",
    );

    await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    const balanceAfterFirst = await ledger.balance("tenant-1");

    const result2 = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result2.processed).toBe(0);

    const balanceAfterSecond = await ledger.balance("tenant-1");
    expect(balanceAfterSecond.toCents()).toBe(balanceAfterFirst.toCents());
  });
});
