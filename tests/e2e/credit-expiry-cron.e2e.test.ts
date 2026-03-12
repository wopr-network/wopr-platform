import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Credit } from "@wopr-network/platform-core";
import { DrizzleCreditLedger } from "@wopr-network/platform-core";
import { runCreditExpiryCron } from "@wopr-network/platform-core/monetization/credits/credit-expiry-cron";
import { createTestDb } from "@wopr-network/platform-core/test/db";

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("credit-expiry-cron e2e", () => {
  let pool: PGlite;
  let ledger: DrizzleCreditLedger;

  beforeEach(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    ledger = new DrizzleCreditLedger(db);
  });

  afterEach(async () => {
    await pool?.close();
  });

  it("full expiry — sweeps entire grant and zeros balance", async () => {
    const tenantId = randomUUID();

    await ledger.credit(
      tenantId,
      Credit.fromCents(500),
      "promo",
      "New user bonus",
      `promo:${tenantId}`,
      undefined,
      undefined,
      "2026-01-10T00:00:00Z",
    );

    const before = await ledger.balance(tenantId);
    expect(before.toCents()).toBe(500);

    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });

    expect(result.processed).toBe(1);
    expect(result.expired).toContain(tenantId);
    expect(result.errors).toEqual([]);

    const after = await ledger.balance(tenantId);
    expect(after.toCents()).toBe(0);

    const history = await ledger.history(tenantId);
    const expiryDebit = history.find(
      (tx) => tx.type === "credit_expiry" && tx.referenceId?.startsWith("expiry:"),
    );
    expect(expiryDebit).toBeDefined();
    expect(expiryDebit!.amount.toCents()).toBe(-500);
  });

  it("partial consumption — only sweeps remaining 200 after spending 300", async () => {
    const tenantId = randomUUID();

    await ledger.credit(
      tenantId,
      Credit.fromCents(500),
      "promo",
      "Promo grant",
      `promo:partial:${tenantId}`,
      undefined,
      undefined,
      "2026-01-10T00:00:00Z",
    );

    await ledger.debit(tenantId, Credit.fromCents(300), "bot_runtime", "Usage charge");

    const beforeCron = await ledger.balance(tenantId);
    expect(beforeCron.toCents()).toBe(200);

    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });

    expect(result.processed).toBe(1);
    expect(result.expired).toContain(tenantId);

    const after = await ledger.balance(tenantId);
    expect(after.toCents()).toBe(0);

    const history = await ledger.history(tenantId);
    const expiryDebit = history.find(
      (tx) => tx.type === "credit_expiry" && tx.referenceId?.startsWith("expiry:"),
    );
    expect(expiryDebit).toBeDefined();
    expect(expiryDebit!.amount.toCents()).toBe(-200);
  });

  it("idempotency — second cron run does not double-deduct", async () => {
    const tenantId = randomUUID();

    await ledger.credit(
      tenantId,
      Credit.fromCents(500),
      "promo",
      "Promo",
      `promo:idemp:${tenantId}`,
      undefined,
      undefined,
      "2026-01-10T00:00:00Z",
    );

    const result1 = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result1.processed).toBe(1);

    const balanceAfterFirst = await ledger.balance(tenantId);
    expect(balanceAfterFirst.toCents()).toBe(0);

    const result2 = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });
    expect(result2.processed).toBe(0);
    expect(result2.errors).toEqual([]);

    const balanceAfterSecond = await ledger.balance(tenantId);
    expect(balanceAfterSecond.toCents()).toBe(0);
  });

  it("zero balance tenant — skipped without error, skippedZeroBalance incremented", async () => {
    const tenantId = randomUUID();

    await ledger.credit(
      tenantId,
      Credit.fromCents(500),
      "promo",
      "Promo",
      `promo:zero:${tenantId}`,
      undefined,
      undefined,
      "2026-01-10T00:00:00Z",
    );
    await ledger.debit(tenantId, Credit.fromCents(500), "bot_runtime", "Full usage");

    const before = await ledger.balance(tenantId);
    expect(before.toCents()).toBe(0);

    const result = await runCreditExpiryCron({ ledger, now: "2026-01-15T00:00:00Z" });

    expect(result.processed).toBe(0);
    expect(result.skippedZeroBalance).toBe(1);
    expect(result.errors).toEqual([]);

    const after = await ledger.balance(tenantId);
    expect(after.toCents()).toBe(0);
  });
});
