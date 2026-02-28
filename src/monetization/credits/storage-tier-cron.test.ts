import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger } from "./credit-ledger.js";
import { runRuntimeDeductions } from "./runtime-cron.js";

describe("runtime cron with storage tiers", () => {
  const TODAY = "2025-01-01";
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

  it("debits base cost plus storage surcharge for pro tier", async () => {
    await ledger.credit("t1", Credit.fromCents(1000), "purchase");
    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: async () => 1,
      getStorageTierCosts: async () => Credit.fromCents(8),
    });
    expect(result.processed).toBe(1);
    const balance = await ledger.balance("t1");
    // 1000 - 17 (base) - 8 (pro storage surcharge) = 975
    expect(balance.toCents()).toBe(975);
  });

  it("debits only base cost for standard storage tier (zero surcharge)", async () => {
    await ledger.credit("t1", Credit.fromCents(1000), "purchase");
    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: async () => 1,
      getStorageTierCosts: async () => Credit.ZERO,
    });
    expect(result.processed).toBe(1);
    expect((await ledger.balance("t1")).toCents()).toBe(983); // 1000 - 17
  });

  it("skips storage surcharge when callback not provided (backward compat)", async () => {
    await ledger.credit("t1", Credit.fromCents(1000), "purchase");
    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: async () => 1,
    });
    expect(result.processed).toBe(1);
    expect((await ledger.balance("t1")).toCents()).toBe(983); // 1000 - 17
  });

  it("suspends tenant when storage surcharge exhausts remaining balance", async () => {
    await ledger.credit("t1", Credit.fromCents(20), "purchase"); // Only 20 cents
    const suspended: string[] = [];
    const result = await runRuntimeDeductions({
      ledger,
      date: TODAY,
      getActiveBotCount: async () => 1,
      getStorageTierCosts: async () => Credit.fromCents(8),
      onSuspend: (tenantId) => {
        suspended.push(tenantId);
      },
    });
    // 20 - 17 = 3 remaining, then 8 surcharge > 3, so partial debit + suspend
    expect(result.processed).toBe(1);
    expect(result.suspended).toContain("t1");
    expect((await ledger.balance("t1")).toCents()).toBe(0);
  });
});
