import type { PGlite } from "@electric-sql/pglite";
import { CreditLedger, grantSignupCredits, SIGNUP_GRANT } from "@wopr-network/platform-core/credits";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";

describe("grantSignupCredits", () => {
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

  it("grants credits to a new tenant and returns true", async () => {
    const result = await grantSignupCredits(ledger, "tenant-1");
    expect(result).toBe(true);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(SIGNUP_GRANT.toCents());
  });

  it("returns false for duplicate grant (idempotency)", async () => {
    await grantSignupCredits(ledger, "tenant-1");
    const result = await grantSignupCredits(ledger, "tenant-1");
    expect(result).toBe(false);
    expect((await ledger.balance("tenant-1")).toCents()).toBe(SIGNUP_GRANT.toCents());
  });

  it("grants independently to different tenants", async () => {
    await grantSignupCredits(ledger, "tenant-1");
    await grantSignupCredits(ledger, "tenant-2");
    expect((await ledger.balance("tenant-1")).toCents()).toBe(SIGNUP_GRANT.toCents());
    expect((await ledger.balance("tenant-2")).toCents()).toBe(SIGNUP_GRANT.toCents());
  });

  it("SIGNUP_GRANT.toCents() equals 500", () => {
    expect(SIGNUP_GRANT.toCents()).toBe(500);
  });

  it("returns false when credit() throws a unique constraint violation (TOCTOU race)", async () => {
    // Simulate two concurrent requests: both pass hasReferenceId check,
    // then the second credit() call loses the race and gets a unique constraint error.
    const uniqueErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    const racingLedger = new CreditLedger(db);
    vi.spyOn(racingLedger, "hasReferenceId").mockResolvedValue(false);
    vi.spyOn(racingLedger, "credit").mockRejectedValue(uniqueErr);

    const result = await grantSignupCredits(racingLedger, "tenant-race");
    expect(result).toBe(false);
  });
});
