import crypto from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import type { ITenantCustomerStore } from "../stripe/tenant-store.js";
import { type AutoTopupChargeDeps, chargeAutoTopup, MAX_CONSECUTIVE_FAILURES } from "./auto-topup-charge.js";
import { DrizzleAutoTopupEventLogRepository } from "./auto-topup-event-log-repository.js";
import { CreditLedger } from "./credit-ledger.js";

interface TopupLogRow {
  id: string;
  tenant_id: string;
  amount_cents: number;
  status: string;
  failure_reason: string | null;
  payment_reference: string | null;
  created_at: string;
}

function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL, type TEXT NOT NULL, description TEXT,
      reference_id TEXT UNIQUE, funding_source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_auto_topup (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL, failure_reason TEXT, payment_reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function mockStripe(overrides?: { paymentIntentId?: string; shouldFail?: boolean; failMessage?: string }) {
  const piId = overrides?.paymentIntentId ?? `pi_${crypto.randomUUID()}`;
  return {
    paymentIntents: {
      create: vi.fn().mockImplementation(async () => {
        if (overrides?.shouldFail) throw new Error(overrides.failMessage ?? "card_declined");
        return { id: piId, status: "succeeded" };
      }),
    },
    customers: {
      listPaymentMethods: vi.fn().mockResolvedValue({ data: [{ id: "pm_123" }] }),
    },
  };
}

function mockTenantStore(stripeCustomerId = "cus_123") {
  return {
    getByTenant: vi.fn().mockReturnValue({ tenant: "t1", processor_customer_id: stripeCustomerId }),
  };
}

describe("chargeAutoTopup", () => {
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

  it("charges Stripe and credits ledger on success", async () => {
    const stripe = mockStripe();
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(true);
    expect(result.paymentReference).toBeDefined();
    expect(ledger.balance("t1")).toBe(500);
    const history = ledger.history("t1");
    expect(history[0].type).toBe("purchase");
    expect(history[0].fundingSource).toBe("stripe");
  });

  it("writes success event to credit_auto_topup log", async () => {
    const stripe = mockStripe();
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    const events = sqlite.prepare("SELECT * FROM credit_auto_topup WHERE tenant_id = ?").all("t1") as TopupLogRow[];
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("success");
    expect(events[0].amount_cents).toBe(500);
  });

  it("returns failure result and writes failure event on Stripe error", async () => {
    const stripe = mockStripe({ shouldFail: true, failMessage: "card_declined" });
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(false);
    expect(result.error).toContain("card_declined");
    expect(ledger.balance("t1")).toBe(0);
    const events = sqlite.prepare("SELECT * FROM credit_auto_topup WHERE tenant_id = ?").all("t1") as TopupLogRow[];
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("failed");
  });

  it("returns failure when tenant has no Stripe customer", async () => {
    const stripe = mockStripe();
    const tenantStore = { getByTenant: vi.fn().mockReturnValue(null) };
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No Stripe customer");
  });

  it("returns failure when tenant has no payment methods", async () => {
    const stripe = mockStripe();
    stripe.customers.listPaymentMethods = vi.fn().mockResolvedValue({ data: [] });
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    const result = await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No payment method");
  });

  it("is idempotent -- referenceId already credited means hasReferenceId returns true", async () => {
    const piId = `pi_${crypto.randomUUID()}`;
    const stripe = mockStripe({ paymentIntentId: piId });
    const tenantStore = mockTenantStore();
    const deps: AutoTopupChargeDeps = {
      stripe: stripe as unknown as Stripe,
      tenantStore: tenantStore as unknown as ITenantCustomerStore,
      creditLedger: ledger,
      eventLogRepo: new DrizzleAutoTopupEventLogRepository(db),
    };

    await chargeAutoTopup(deps, "t1", 500, "auto_topup_usage");
    expect(ledger.balance("t1")).toBe(500);
    expect(ledger.hasReferenceId(piId)).toBe(true);
  });

  it("exports MAX_CONSECUTIVE_FAILURES as 3", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
  });
});
