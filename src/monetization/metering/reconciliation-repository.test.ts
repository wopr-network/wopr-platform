import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, seedUsageSummary, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { DrizzleAdapterUsageRepository, DrizzleUsageSummaryRepository } from "./reconciliation-repository.js";

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

/** Epoch ms for a given date string. */
function epochMs(dateStr: string): number {
  return new Date(dateStr).getTime();
}

describe("DrizzleUsageSummaryRepository", () => {
  let repo: DrizzleUsageSummaryRepository;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleUsageSummaryRepository(db);
  });

  it("returns empty array when no usage summaries exist", async () => {
    const result = await repo.getAggregatedChargesByWindow(0, Date.now());
    expect(result).toEqual([]);
  });

  it("aggregates charges per tenant within [windowStart, windowEnd)", async () => {
    const dayStart = epochMs("2026-02-15T00:00:00Z");
    const dayEnd = epochMs("2026-02-16T00:00:00Z");

    // Two summaries for t1 within window
    await seedUsageSummary(db, {
      id: crypto.randomUUID(),
      tenant: "t1",
      totalCharge: 5000,
      windowStart: dayStart,
      windowEnd: dayStart + 3600000,
    });
    await seedUsageSummary(db, {
      id: crypto.randomUUID(),
      tenant: "t1",
      totalCharge: 3000,
      windowStart: dayStart + 3600000,
      windowEnd: dayStart + 7200000,
    });

    // One summary for t2 within window
    await seedUsageSummary(db, {
      id: crypto.randomUUID(),
      tenant: "t2",
      totalCharge: 1000,
      windowStart: dayStart,
      windowEnd: dayStart + 3600000,
    });

    const result = await repo.getAggregatedChargesByWindow(dayStart, dayEnd);

    expect(result).toHaveLength(2);
    const t1 = result.find((r) => r.tenant === "t1");
    const t2 = result.find((r) => r.tenant === "t2");
    expect(t1?.totalChargeRaw).toBe(8000); // 5000 + 3000
    expect(t2?.totalChargeRaw).toBe(1000);
  });

  it("excludes __sentinel__ rows", async () => {
    const dayStart = epochMs("2026-02-15T00:00:00Z");

    await seedUsageSummary(db, {
      id: crypto.randomUUID(),
      tenant: "__sentinel__",
      totalCharge: 999999,
      windowStart: dayStart,
      windowEnd: dayStart + 3600000,
    });
    await seedUsageSummary(db, {
      id: crypto.randomUUID(),
      tenant: "t1",
      totalCharge: 100,
      windowStart: dayStart,
      windowEnd: dayStart + 3600000,
    });

    const result = await repo.getAggregatedChargesByWindow(dayStart, dayStart + 86400000);
    expect(result).toHaveLength(1);
    expect(result[0].tenant).toBe("t1");
  });

  it("excludes summaries outside the window", async () => {
    const dayStart = epochMs("2026-02-15T00:00:00Z");
    const dayEnd = epochMs("2026-02-16T00:00:00Z");

    // Before window
    await seedUsageSummary(db, {
      id: crypto.randomUUID(),
      tenant: "t1",
      totalCharge: 100,
      windowStart: epochMs("2026-02-14T00:00:00Z"),
      windowEnd: epochMs("2026-02-14T01:00:00Z"),
    });

    // After window
    await seedUsageSummary(db, {
      id: crypto.randomUUID(),
      tenant: "t1",
      totalCharge: 200,
      windowStart: dayEnd,
      windowEnd: dayEnd + 3600000,
    });

    const result = await repo.getAggregatedChargesByWindow(dayStart, dayEnd);
    expect(result).toEqual([]);
  });
});

describe("DrizzleAdapterUsageRepository", () => {
  let repo: DrizzleAdapterUsageRepository;
  let ledger: CreditLedger;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleAdapterUsageRepository(db);
    ledger = new CreditLedger(db);
  });

  it("returns empty array when no adapter_usage debits exist", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const startIso = `${today}T00:00:00Z`;
    const endIso = new Date(new Date(startIso).getTime() + 86400000).toISOString();
    const result = await repo.getAggregatedAdapterUsageDebits(startIso, endIso);
    expect(result).toEqual([]);
  });

  it("aggregates adapter_usage debits per tenant within [startIso, endIso)", async () => {
    // Fund tenants
    await ledger.credit("t1", Credit.fromCents(1000), "purchase");
    await ledger.credit("t2", Credit.fromCents(1000), "purchase");

    await ledger.debit("t1", Credit.fromCents(30), "adapter_usage", "t1-debit-1");
    await ledger.debit("t1", Credit.fromCents(20), "adapter_usage", "t1-debit-2");
    await ledger.debit("t2", Credit.fromCents(50), "adapter_usage", "t2-debit-1");

    // Query window covering today
    const today = new Date().toISOString().slice(0, 10);
    const startIso = `${today}T00:00:00Z`;
    const endIso = new Date(new Date(startIso).getTime() + 86400000).toISOString();

    const result = await repo.getAggregatedAdapterUsageDebits(startIso, endIso);
    expect(result).toHaveLength(2);

    const t1 = result.find((r) => r.tenantId === "t1");
    const t2 = result.find((r) => r.tenantId === "t2");

    expect(t1?.totalDebitRaw).toBe(Credit.fromCents(50).toRaw()); // 30 + 20
    expect(t2?.totalDebitRaw).toBe(Credit.fromCents(50).toRaw());
  });

  it("excludes non-adapter_usage debit types", async () => {
    await ledger.credit("t1", Credit.fromCents(1000), "purchase");
    await ledger.debit("t1", Credit.fromCents(30), "adapter_usage", "adapter debit");
    await ledger.debit("t1", Credit.fromCents(20), "bot_runtime", "runtime debit");

    const today = new Date().toISOString().slice(0, 10);
    const startIso = `${today}T00:00:00Z`;
    const endIso = new Date(new Date(startIso).getTime() + 86400000).toISOString();

    const result = await repo.getAggregatedAdapterUsageDebits(startIso, endIso);
    expect(result).toHaveLength(1);
    expect(result[0].totalDebitRaw).toBe(Credit.fromCents(30).toRaw());
  });

  it("excludes credit transactions (positive amounts are not debits)", async () => {
    await ledger.credit("t1", Credit.fromCents(1000), "purchase");
    await ledger.debit("t1", Credit.fromCents(10), "adapter_usage", "real debit");

    const today = new Date().toISOString().slice(0, 10);
    const startIso = `${today}T00:00:00Z`;
    const endIso = new Date(new Date(startIso).getTime() + 86400000).toISOString();

    const result = await repo.getAggregatedAdapterUsageDebits(startIso, endIso);
    expect(result).toHaveLength(1);
    // Only the 10-cent adapter_usage debit
    expect(result[0].totalDebitRaw).toBe(Credit.fromCents(10).toRaw());
  });
});
