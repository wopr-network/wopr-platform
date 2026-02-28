import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { usageSummaries } from "../../db/schema/meter-events.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { runReconciliation } from "./reconciliation-cron.js";
import { DrizzleAdapterUsageRepository, DrizzleUsageSummaryRepository } from "./reconciliation-repository.js";

/** Today's date as YYYY-MM-DD (UTC). We use "today" as targetDate since the
 *  credit ledger inserts use `now()` for createdAt, so debits land in today's window. */
const TODAY = new Date().toISOString().slice(0, 10);
const DAY_START = new Date(`${TODAY}T00:00:00Z`).getTime();
const DAY_END = DAY_START + 24 * 60 * 60 * 1000;

describe("runReconciliation", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;
  let usageSummaryRepo: DrizzleUsageSummaryRepository;
  let adapterUsageRepo: DrizzleAdapterUsageRepository;

  beforeAll(async () => {
    const t = await createTestDb();
    pool = t.pool;
    db = t.db;
    ledger = new CreditLedger(db);
    usageSummaryRepo = new DrizzleUsageSummaryRepository(db);
    adapterUsageRepo = new DrizzleAdapterUsageRepository(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  /** Insert a usage_summaries row directly. */
  async function insertSummary(opts: {
    tenant: string;
    totalCharge: number;
    windowStart?: number;
    windowEnd?: number;
    capability?: string;
    provider?: string;
  }) {
    await db.insert(usageSummaries).values({
      id: crypto.randomUUID(),
      tenant: opts.tenant,
      capability: opts.capability ?? "chat",
      provider: opts.provider ?? "openai",
      eventCount: 1,
      totalCost: 0,
      totalCharge: opts.totalCharge,
      totalDuration: 0,
      windowStart: opts.windowStart ?? DAY_START,
      windowEnd: opts.windowEnd ?? DAY_END - 1,
    });
  }

  it("returns empty result when no metering or ledger data", async () => {
    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    expect(result.tenantsChecked).toBe(0);
    expect(result.discrepancies).toEqual([]);
    expect(result.flagged).toEqual([]);
    expect(result.date).toBe(TODAY);
  });

  it("no discrepancy when metered charge matches ledger debit", async () => {
    const charge = Credit.fromCents(50);
    await insertSummary({ tenant: "t1", totalCharge: charge.toRaw() });

    await ledger.credit("t1", Credit.fromCents(500), "purchase");
    await ledger.debit("t1", charge, "adapter_usage", "chat usage");

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    expect(result.tenantsChecked).toBe(1);
    expect(result.discrepancies).toEqual([]);
  });

  it("detects drift when metered charge exceeds ledger debit", async () => {
    await insertSummary({ tenant: "t1", totalCharge: Credit.fromCents(100).toRaw() });

    await ledger.credit("t1", Credit.fromCents(500), "purchase");
    await ledger.debit("t1", Credit.fromCents(80), "adapter_usage", "chat usage");

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    expect(result.tenantsChecked).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].tenantId).toBe("t1");
    // drift = metered(100c) - ledger(80c) = 20c, in raw units
    expect(result.discrepancies[0].driftRaw).toBe(Credit.fromCents(20).toRaw());
  });

  it("flags tenant when drift exceeds flag threshold", async () => {
    await insertSummary({ tenant: "t1", totalCharge: Credit.fromCents(200).toRaw() });

    // No ledger debit at all — simulating a missed deduction
    const onFlagForReview = vi.fn();
    const result = await runReconciliation({
      usageSummaryRepo,
      adapterUsageRepo,
      targetDate: TODAY,
      flagThresholdRaw: Credit.fromCents(100).toRaw(), // $1.00
      onFlagForReview,
    });

    expect(result.flagged).toContain("t1");
    expect(onFlagForReview).toHaveBeenCalledWith("t1", Credit.fromCents(200).toRaw());
  });

  it("ignores non-adapter_usage debits (bot_runtime, etc.)", async () => {
    await insertSummary({ tenant: "t1", totalCharge: Credit.fromCents(20).toRaw() });

    await ledger.credit("t1", Credit.fromCents(500), "purchase");
    // Debit as bot_runtime — should NOT count toward reconciliation
    await ledger.debit("t1", Credit.fromCents(20), "bot_runtime", "daily runtime");

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    // Metered 20c, ledger adapter_usage = 0 => drift = 20c
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].driftRaw).toBe(Credit.fromCents(20).toRaw());
  });

  it("ignores __sentinel__ rows from usage_summaries", async () => {
    // Insert a sentinel row (should be ignored)
    await db.insert(usageSummaries).values({
      id: crypto.randomUUID(),
      tenant: "__sentinel__",
      capability: "__none__",
      provider: "__none__",
      eventCount: 0,
      totalCost: 0,
      totalCharge: 0,
      totalDuration: 0,
      windowStart: DAY_START,
      windowEnd: DAY_END - 1,
    });

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    expect(result.tenantsChecked).toBe(0);
    expect(result.discrepancies).toEqual([]);
  });

  it("handles multiple tenants independently", async () => {
    // t1: balanced
    await insertSummary({ tenant: "t1", totalCharge: Credit.fromCents(50).toRaw() });
    await ledger.credit("t1", Credit.fromCents(500), "purchase");
    await ledger.debit("t1", Credit.fromCents(50), "adapter_usage", "chat");

    // t2: drifted
    await insertSummary({ tenant: "t2", totalCharge: Credit.fromCents(100).toRaw() });
    await ledger.credit("t2", Credit.fromCents(500), "purchase");
    await ledger.debit("t2", Credit.fromCents(60), "adapter_usage", "chat");

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    expect(result.tenantsChecked).toBe(2);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].tenantId).toBe("t2");
    expect(result.discrepancies[0].driftRaw).toBe(Credit.fromCents(40).toRaw());
  });

  it("uses yesterday as default targetDate", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const expectedDate = yesterday.toISOString().slice(0, 10);

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo });
    expect(result.date).toBe(expectedDate);
    expect(result.tenantsChecked).toBe(0);
  });

  it("ignores metering data outside the target date window", async () => {
    // Summary from yesterday — should not appear in today's reconciliation
    const yesterday = new Date(`${TODAY}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000;
    await insertSummary({
      tenant: "t1",
      totalCharge: Credit.fromCents(100).toRaw(),
      windowStart: yesterday,
      windowEnd: yesterday + 24 * 60 * 60 * 1000 - 1,
    });

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    expect(result.tenantsChecked).toBe(0);
  });

  it("handles over-billed drift (ledger > metered)", async () => {
    // Metered 50c but debited 80c (over-billed)
    await insertSummary({ tenant: "t1", totalCharge: Credit.fromCents(50).toRaw() });

    await ledger.credit("t1", Credit.fromCents(500), "purchase");
    await ledger.debit("t1", Credit.fromCents(80), "adapter_usage", "chat usage");

    const result = await runReconciliation({ usageSummaryRepo, adapterUsageRepo, targetDate: TODAY });
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].driftRaw).toBe(Credit.fromCents(-30).toRaw());
  });
});
