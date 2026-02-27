import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { CreditLedger } from "./credit-ledger.js";
import { grantSignupCredits, SIGNUP_GRANT_CENTS } from "./signup-grant.js";

describe("grantSignupCredits", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("grants credits to a new tenant and returns true", async () => {
    const result = await grantSignupCredits(ledger, "tenant-1");
    expect(result).toBe(true);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(SIGNUP_GRANT_CENTS);
  });

  it("returns false for duplicate grant (idempotency)", async () => {
    await grantSignupCredits(ledger, "tenant-1");
    const result = await grantSignupCredits(ledger, "tenant-1");
    expect(result).toBe(false);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(SIGNUP_GRANT_CENTS);
  });

  it("grants independently to different tenants", async () => {
    await grantSignupCredits(ledger, "tenant-1");
    await grantSignupCredits(ledger, "tenant-2");
    expect((await ledger.balance("tenant-1")).toCents()).toBe(SIGNUP_GRANT_CENTS);
    expect((await ledger.balance("tenant-2")).toCents()).toBe(SIGNUP_GRANT_CENTS);
  });

  it("SIGNUP_GRANT_CENTS equals 500", () => {
    expect(SIGNUP_GRANT_CENTS).toBe(500);
  });
});
