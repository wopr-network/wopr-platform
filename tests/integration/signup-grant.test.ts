import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { createTestDb } from "../../src/test/db.js";
import { CreditLedger } from "@wopr-network/platform-core";
import { grantSignupCredits, SIGNUP_GRANT } from "@wopr-network/platform-core/credits";

describe("integration: signup grant", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("awards $5.00 signup grant to a new tenant", async () => {
    const tenantId = `tenant-${randomUUID()}`;

    const granted = await grantSignupCredits(ledger, tenantId);
    expect(granted).toBe(true);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500);
  });

  it("double verification keeps balance at $5.00, not $10.00", async () => {
    const tenantId = `tenant-${randomUUID()}`;

    const first = await grantSignupCredits(ledger, tenantId);
    expect(first).toBe(true);

    const second = await grantSignupCredits(ledger, tenantId);
    expect(second).toBe(false);

    const balance = await ledger.balance(tenantId);
    expect(balance.toCents()).toBe(500);

    const hasRef = await ledger.hasReferenceId(`signup:${tenantId}`);
    expect(hasRef).toBe(true);
  });

  it("signup grant appears in transaction history with correct type and amount", async () => {
    const tenantId = `tenant-${randomUUID()}`;

    await grantSignupCredits(ledger, tenantId);

    const history = await ledger.history(tenantId);
    expect(history).toHaveLength(1);

    const txn = history[0];
    expect(txn.type).toBe("signup_grant");
    expect(txn.amount.toCents()).toBe(500);
    expect(txn.referenceId).toBe(`signup:${tenantId}`);
    expect(txn.tenantId).toBe(tenantId);
    expect(txn.description).toBe("Welcome bonus — $5.00 credit on email verification");
  });
});
