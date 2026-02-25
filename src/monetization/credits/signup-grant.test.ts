import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { CreditLedger } from "./credit-ledger.js";
import { grantSignupCredits, SIGNUP_GRANT_CENTS } from "./signup-grant.js";

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

describe("grantSignupCredits", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let ledger: CreditLedger;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    ledger = new CreditLedger(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("grants credits to a new tenant and returns true", () => {
    const result = grantSignupCredits(ledger, "tenant-1");
    expect(result).toBe(true);
    expect(ledger.balance("tenant-1")).toBe(SIGNUP_GRANT_CENTS);
  });

  it("returns false for duplicate grant (idempotency)", () => {
    grantSignupCredits(ledger, "tenant-1");
    const result = grantSignupCredits(ledger, "tenant-1");
    expect(result).toBe(false);
    // Balance should not double
    expect(ledger.balance("tenant-1")).toBe(SIGNUP_GRANT_CENTS);
  });

  it("grants independently to different tenants", () => {
    grantSignupCredits(ledger, "tenant-1");
    grantSignupCredits(ledger, "tenant-2");
    expect(ledger.balance("tenant-1")).toBe(SIGNUP_GRANT_CENTS);
    expect(ledger.balance("tenant-2")).toBe(SIGNUP_GRANT_CENTS);
  });

  it("SIGNUP_GRANT_CENTS equals 500", () => {
    expect(SIGNUP_GRANT_CENTS).toBe(500);
  });
});
