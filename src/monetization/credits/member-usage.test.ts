import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { CreditLedger } from "./credit-ledger.js";

describe("DrizzleCreditLedger.memberUsage", () => {
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

  it("should aggregate debit totals per attributed user", async () => {
    await ledger.credit("org-1", 10000, "purchase", "Seed");
    await ledger.debit("org-1", 100, "adapter_usage", "Chat", undefined, false, "user-a");
    await ledger.debit("org-1", 200, "adapter_usage", "Chat", undefined, false, "user-a");
    await ledger.debit("org-1", 300, "adapter_usage", "Chat", undefined, false, "user-b");

    const result = await ledger.memberUsage("org-1");
    expect(result).toHaveLength(2);

    const userA = result.find((r) => r.userId === "user-a");
    expect(userA?.totalDebitCredits).toBe(300);
    expect(userA?.transactionCount).toBe(2);

    const userB = result.find((r) => r.userId === "user-b");
    expect(userB?.totalDebitCredits).toBe(300);
    expect(userB?.transactionCount).toBe(1);
  });

  it("should exclude transactions with null attributedUserId", async () => {
    await ledger.credit("org-1", 10000, "purchase", "Seed");
    await ledger.debit("org-1", 100, "bot_runtime", "Cron"); // no attributedUserId
    await ledger.debit("org-1", 200, "adapter_usage", "Chat", undefined, false, "user-a");

    const result = await ledger.memberUsage("org-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-a");
  });

  it("should return empty array when no attributed debits exist", async () => {
    const result = await ledger.memberUsage("org-1");
    expect(result).toEqual([]);
  });
});
