/**
 * Tests for gateway credit gate — grace buffer and credits_exhausted behavior (WOP-821).
 */

import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../db/index.js";
import { CreditLedger } from "../monetization/credits/credit-ledger.js";
import { type CreditGateDeps, creditBalanceCheck, debitCredits } from "./credit-gate.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";
import type { GatewayTenant } from "./types.js";

function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT UNIQUE,
      funding_source TEXT,
      attributed_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function makeLedgerWithBalance(tenantId: string, balanceCents: number): CreditLedger {
  const sqlite = new BetterSqlite3(":memory:");
  initTestSchema(sqlite);
  const db = createDb(sqlite);
  const ledger = new CreditLedger(db);
  if (balanceCents > 0) {
    ledger.credit(tenantId, balanceCents, "purchase", "setup");
  } else if (balanceCents < 0) {
    // Set up negative balance: credit a positive amount, then debit with allowNegative
    ledger.credit(tenantId, 1, "purchase", "setup");
    ledger.debit(tenantId, 1 + Math.abs(balanceCents), "adapter_usage", "drain", undefined, true);
  }
  return ledger;
}

// Build a real Hono context for testing by extracting it from a handler
async function buildHonoContext(tenantId: string): Promise<import("hono").Context<GatewayAuthEnv>> {
  let capturedCtx!: import("hono").Context<GatewayAuthEnv>;
  const app = new Hono<GatewayAuthEnv>();
  app.get("/test", (c) => {
    c.set("gatewayTenant", {
      id: tenantId,
      spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
    } as GatewayTenant);
    capturedCtx = c;
    return c.json({});
  });
  await app.request("/test");
  return capturedCtx;
}

// ---------------------------------------------------------------------------
// creditBalanceCheck — grace buffer tests
// ---------------------------------------------------------------------------

describe("creditBalanceCheck grace buffer", () => {
  it("returns null when balance is above estimated cost (passes)", async () => {
    const ledger = makeLedgerWithBalance("t1", 500);
    const c = await buildHonoContext("t1");
    const deps: CreditGateDeps = { creditLedger: ledger, topUpUrl: "/billing" };
    expect(creditBalanceCheck(c, deps, 1)).toBeNull();
  });

  it("returns null when balance is zero but within default grace buffer (passes)", async () => {
    // Balance at exactly 0 — within the -50 grace buffer
    // Add 0 balance row by doing credit+full debit
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const zeroLedger = new CreditLedger(db);
    zeroLedger.credit("t1", 10, "purchase", "setup");
    zeroLedger.debit("t1", 10, "adapter_usage", "drain");
    const c = await buildHonoContext("t1");
    const deps: CreditGateDeps = { creditLedger: zeroLedger, topUpUrl: "/billing" };
    expect(creditBalanceCheck(c, deps, 0)).toBeNull();
  });

  it("returns null when balance is -49 (within 50-cent grace buffer)", async () => {
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const ledger = new CreditLedger(db);
    ledger.credit("t1", 1, "purchase", "setup");
    ledger.debit("t1", 50, "adapter_usage", "drain", undefined, true); // balance = -49
    const c = await buildHonoContext("t1");
    const deps: CreditGateDeps = { creditLedger: ledger, topUpUrl: "/billing" };
    expect(creditBalanceCheck(c, deps, 0)).toBeNull();
  });

  it("returns credits_exhausted when balance is at -50 (at grace buffer limit)", async () => {
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const ledger = new CreditLedger(db);
    ledger.credit("t1", 1, "purchase", "setup");
    ledger.debit("t1", 51, "adapter_usage", "drain", undefined, true); // balance = -50
    const c = await buildHonoContext("t1");
    const deps: CreditGateDeps = { creditLedger: ledger, topUpUrl: "/billing" };
    const result = creditBalanceCheck(c, deps, 0);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("credits_exhausted");
  });

  it("returns credits_exhausted when balance is at -51 (beyond grace buffer)", async () => {
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const ledger = new CreditLedger(db);
    ledger.credit("t1", 1, "purchase", "setup");
    ledger.debit("t1", 52, "adapter_usage", "drain", undefined, true); // balance = -51
    const c = await buildHonoContext("t1");
    const deps: CreditGateDeps = { creditLedger: ledger, topUpUrl: "/billing" };
    const result = creditBalanceCheck(c, deps, 0);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("credits_exhausted");
  });

  it("returns credits_exhausted when custom graceBufferCents=0 and balance is 0", async () => {
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const ledger = new CreditLedger(db);
    ledger.credit("t1", 10, "purchase", "setup");
    ledger.debit("t1", 10, "adapter_usage", "drain"); // balance = 0
    const c = await buildHonoContext("t1");
    const deps: CreditGateDeps = { creditLedger: ledger, topUpUrl: "/billing", graceBufferCents: 0 };
    const result = creditBalanceCheck(c, deps, 0);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("credits_exhausted");
  });

  it("returns insufficient_credits when balance positive but below estimated cost", async () => {
    const ledger = makeLedgerWithBalance("t1", 5);
    const c = await buildHonoContext("t1");
    const deps: CreditGateDeps = { creditLedger: ledger, topUpUrl: "/billing" };
    const result = creditBalanceCheck(c, deps, 10);
    expect(result).not.toBeNull();
    expect(result?.code).toBe("insufficient_credits");
  });
});

// ---------------------------------------------------------------------------
// debitCredits — allowNegative and onBalanceExhausted tests
// ---------------------------------------------------------------------------

describe("debitCredits with allowNegative and onBalanceExhausted", () => {
  it("debit with cost that would exceed balance succeeds (allowNegative=true)", () => {
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const ledger = new CreditLedger(db);
    ledger.credit("t1", 5, "purchase", "setup"); // balance = 5 cents

    // costUsd = $0.10 = 10 cents, margin = 1.0
    // This should push balance negative without throwing
    expect(() => {
      debitCredits({ creditLedger: ledger, topUpUrl: "/billing" }, "t1", 0.1, 1.0, "chat-completions", "openrouter");
    }).not.toThrow();

    expect(ledger.balance("t1")).toBeLessThan(0);
  });

  it("fires onBalanceExhausted when debit causes balance to cross zero", () => {
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const ledger = new CreditLedger(db);
    ledger.credit("t1", 5, "purchase", "setup"); // balance = 5 cents

    const onBalanceExhausted = vi.fn();
    // costUsd = $0.10 = 10 cents with margin 1.0 → chargeCents = 10, pushes balance to -5
    debitCredits(
      { creditLedger: ledger, topUpUrl: "/billing", onBalanceExhausted },
      "t1",
      0.1,
      1.0,
      "chat-completions",
      "openrouter",
    );

    expect(onBalanceExhausted).toHaveBeenCalledWith("t1", -5);
  });

  it("does NOT fire onBalanceExhausted when balance stays positive after debit", () => {
    const sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    const db = createDb(sqlite);
    const ledger = new CreditLedger(db);
    ledger.credit("t1", 500, "purchase", "setup"); // balance = 500 cents

    const onBalanceExhausted = vi.fn();
    // costUsd = $0.01 = 1 cent → balance stays at 499
    debitCredits(
      { creditLedger: ledger, topUpUrl: "/billing", onBalanceExhausted },
      "t1",
      0.01,
      1.0,
      "chat-completions",
      "openrouter",
    );

    expect(onBalanceExhausted).not.toHaveBeenCalled();
    expect(ledger.balance("t1")).toBeGreaterThan(0);
  });
});
