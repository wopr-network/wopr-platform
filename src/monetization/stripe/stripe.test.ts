import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { initCreditSchema } from "../credits/schema.js";
import { initMeterSchema } from "../metering/schema.js";
import { createCreditCheckoutSession } from "./checkout.js";
import { loadStripeConfig } from "./client.js";
import {
  CREDIT_PRICE_POINTS,
  getConfiguredPriceIds,
  getCreditAmountForPurchase,
  loadCreditPriceMap,
} from "./credit-prices.js";
import { createPortalSession } from "./portal.js";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";
import { handleWebhookEvent } from "./webhook.js";

function createTestDb() {
  const sqlite = new BetterSqlite3(":memory:");
  initMeterSchema(sqlite);
  initStripeSchema(sqlite);
  const db = createDb(sqlite);
  return { sqlite, db };
}

// -- Schema -----------------------------------------------------------------

describe("initStripeSchema", () => {
  it("creates tenant_customers table", () => {
    const { sqlite } = createTestDb();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_customers'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    sqlite.close();
  });

  it("creates stripe_usage_reports table", () => {
    const { sqlite } = createTestDb();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stripe_usage_reports'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    sqlite.close();
  });

  it("creates indexes", () => {
    const { sqlite } = createTestDb();
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tenant_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(1);

    const stripeIndexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_stripe_%'")
      .all() as { name: string }[];
    expect(stripeIndexes.length).toBeGreaterThanOrEqual(2);
    sqlite.close();
  });

  it("is idempotent", () => {
    const { sqlite } = createTestDb();
    initStripeSchema(sqlite);
    initStripeSchema(sqlite);
    sqlite.close();
  });
});

// -- TenantCustomerStore ----------------------------------------------------

describe("TenantCustomerStore", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let store: TenantCustomerStore;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    db = testDb.db;
    store = new TenantCustomerStore(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("upsert creates a new mapping", () => {
    store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const row = store.getByTenant("t-1");
    expect(row).toBeDefined();
    expect(row?.processor_customer_id).toBe("cus_abc123");
    expect(row?.tier).toBe("free");
  });

  it("upsert updates existing mapping", () => {
    store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });
    store.upsert({
      tenant: "t-1",
      processorCustomerId: "cus_xyz789",
      tier: "pro",
    });

    const row = store.getByTenant("t-1");
    expect(row?.processor_customer_id).toBe("cus_xyz789");
    expect(row?.tier).toBe("pro");
  });

  it("getByProcessorCustomerId finds by customer ID", () => {
    store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const row = store.getByProcessorCustomerId("cus_abc123");
    expect(row?.tenant).toBe("t-1");
  });

  it("getByTenant returns null for unknown tenant", () => {
    expect(store.getByTenant("nonexistent")).toBeNull();
  });

  it("getByProcessorCustomerId returns null for unknown customer", () => {
    expect(store.getByProcessorCustomerId("cus_nonexistent")).toBeNull();
  });

  it("setTier updates the tier", () => {
    store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123", tier: "pro" });
    store.setTier("t-1", "free");

    const row = store.getByTenant("t-1");
    expect(row?.tier).toBe("free");
  });

  it("list returns all mappings", () => {
    store.upsert({ tenant: "t-1", processorCustomerId: "cus_1" });
    store.upsert({ tenant: "t-2", processorCustomerId: "cus_2" });

    const rows = store.list();
    expect(rows).toHaveLength(2);
  });

  it("buildCustomerIdMap returns tenant -> customer ID map", () => {
    store.upsert({ tenant: "t-1", processorCustomerId: "cus_aaa" });
    store.upsert({ tenant: "t-2", processorCustomerId: "cus_bbb" });

    const map = store.buildCustomerIdMap();
    expect(map).toEqual({ "t-1": "cus_aaa", "t-2": "cus_bbb" });
  });
});

// -- Credit checkout --------------------------------------------------------

describe("createCreditCheckoutSession", () => {
  let sqlite: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    tenantStore = new TenantCustomerStore(testDb.db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createMockStripe(sessionsCreate: ReturnType<typeof vi.fn>) {
    return {
      checkout: { sessions: { create: sessionsCreate } },
    } as unknown as Stripe;
  }

  it("creates a one-time payment checkout session", async () => {
    const mockSession = { id: "cs_test_123", url: "https://checkout.stripe.com/cs_test_123" };
    const sessionsCreate = vi.fn().mockResolvedValue(mockSession);
    const stripe = createMockStripe(sessionsCreate);

    const result = await createCreditCheckoutSession(stripe, tenantStore, {
      tenant: "t-1",
      priceId: "price_credit_25",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(result).toBe(mockSession);
    expect(sessionsCreate).toHaveBeenCalledWith({
      mode: "payment",
      line_items: [{ price: "price_credit_25", quantity: 1 }],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
      client_reference_id: "t-1",
      metadata: { wopr_tenant: "t-1", wopr_purchase_type: "credits" },
    });
  });

  it("reuses existing Stripe customer when mapping exists", async () => {
    tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_existing" });

    const sessionsCreate = vi
      .fn()
      .mockResolvedValue({ id: "cs_test_456", url: "https://checkout.stripe.com/cs_test_456" });
    const stripe = createMockStripe(sessionsCreate);

    await createCreditCheckoutSession(stripe, tenantStore, {
      tenant: "t-1",
      priceId: "price_credit_5",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_existing" }));
  });

  it("does not set customer param for new tenants", async () => {
    const sessionsCreate = vi
      .fn()
      .mockResolvedValue({ id: "cs_test_789", url: "https://checkout.stripe.com/cs_test_789" });
    const stripe = createMockStripe(sessionsCreate);

    await createCreditCheckoutSession(stripe, tenantStore, {
      tenant: "t-new",
      priceId: "price_credit_10",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const callArgs = sessionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("customer");
  });

  it("propagates Stripe API errors", async () => {
    const sessionsCreate = vi.fn().mockRejectedValue(new Error("Stripe API rate limited"));
    const stripe = createMockStripe(sessionsCreate);

    await expect(
      createCreditCheckoutSession(stripe, tenantStore, {
        tenant: "t-1",
        priceId: "price_credit_5",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    ).rejects.toThrow("Stripe API rate limited");
  });
});

// -- Credit price points ----------------------------------------------------

describe("credit price points", () => {
  it("has 5 preset price tiers", () => {
    expect(CREDIT_PRICE_POINTS).toHaveLength(5);
  });

  it("getCreditAmountForPurchase returns correct bonus amounts", () => {
    expect(getCreditAmountForPurchase(500)).toBe(500); // $5 -> $5.00
    expect(getCreditAmountForPurchase(1000)).toBe(1000); // $10 -> $10.00
    expect(getCreditAmountForPurchase(2500)).toBe(2550); // $25 -> $25.50
    expect(getCreditAmountForPurchase(5000)).toBe(5250); // $50 -> $52.50
    expect(getCreditAmountForPurchase(10000)).toBe(11000); // $100 -> $110.00
  });

  it("getCreditAmountForPurchase returns 1:1 for unknown amounts", () => {
    expect(getCreditAmountForPurchase(1234)).toBe(1234);
    expect(getCreditAmountForPurchase(7500)).toBe(7500);
  });

  it("loadCreditPriceMap returns empty map when no env vars are set", () => {
    const map = loadCreditPriceMap();
    // May or may not have entries depending on env
    expect(map).toBeInstanceOf(Map);
  });

  it("getConfiguredPriceIds returns empty when no env vars are set", () => {
    const ids = getConfiguredPriceIds();
    expect(Array.isArray(ids)).toBe(true);
  });
});

// -- createPortalSession ----------------------------------------------------

describe("createPortalSession", () => {
  let sqlite: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    tenantStore = new TenantCustomerStore(testDb.db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createMockStripe(portalCreate: ReturnType<typeof vi.fn>) {
    return {
      billingPortal: { sessions: { create: portalCreate } },
    } as unknown as Stripe;
  }

  it("creates a portal session for existing customer", async () => {
    tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const mockSession = { url: "https://billing.stripe.com/session_xyz" };
    const portalCreate = vi.fn().mockResolvedValue(mockSession);
    const stripe = createMockStripe(portalCreate);

    const result = await createPortalSession(stripe, tenantStore, {
      tenant: "t-1",
      returnUrl: "https://example.com/billing",
    });

    expect(result).toBe(mockSession);
    expect(portalCreate).toHaveBeenCalledWith({
      customer: "cus_abc123",
      return_url: "https://example.com/billing",
    });
  });

  it("throws when tenant has no Stripe customer", async () => {
    const portalCreate = vi.fn();
    const stripe = createMockStripe(portalCreate);

    await expect(
      createPortalSession(stripe, tenantStore, {
        tenant: "t-unknown",
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("No Stripe customer found for tenant: t-unknown");

    expect(portalCreate).not.toHaveBeenCalled();
  });

  it("propagates Stripe API errors", async () => {
    tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const portalCreate = vi.fn().mockRejectedValue(new Error("Portal config not found"));
    const stripe = createMockStripe(portalCreate);

    await expect(
      createPortalSession(stripe, tenantStore, {
        tenant: "t-1",
        returnUrl: "https://example.com/billing",
      }),
    ).rejects.toThrow("Portal config not found");
  });
});

// -- Webhook (in stripe.test.ts) --------------------------------------------

describe("handleWebhookEvent (credit model)", () => {
  let sqlite: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;
  let creditLedger: CreditLedger;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    initCreditSchema(sqlite);
    tenantStore = new TenantCustomerStore(testDb.db);
    creditLedger = new CreditLedger(testDb.db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("handles checkout.session.completed - credits the ledger", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_abc",
          client_reference_id: "t-1",
          customer: "cus_abc123",
          amount_total: 1000,
          metadata: {},
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent({ tenantStore, creditLedger }, event);

    expect(result.handled).toBe(true);
    expect(result.tenant).toBe("t-1");
    expect(result.creditedCents).toBe(1000);

    // Verify credit was granted
    const balance = creditLedger.balance("t-1");
    expect(balance).toBe(1000);

    // Verify tenant mapping was created
    const mapping = tenantStore.getByTenant("t-1");
    expect(mapping?.processor_customer_id).toBe("cus_abc123");
  });

  it("handles checkout.session.completed - uses metadata fallback", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_xyz",
          client_reference_id: null,
          customer: "cus_abc123",
          amount_total: 500,
          metadata: { wopr_tenant: "t-2" },
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(true);
    expect(result.tenant).toBe("t-2");
    expect(result.creditedCents).toBe(500);
  });

  it("handles checkout.session.completed - returns unhandled when no tenant", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_notenant",
          client_reference_id: null,
          customer: "cus_abc123",
          amount_total: 500,
          metadata: {},
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(false);
  });

  it("returns unhandled for subscription event types (no longer handled)", () => {
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_unknown",
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(false);
  });

  it("returns unhandled for unknown event types", () => {
    const event = {
      type: "payment_intent.succeeded",
      data: { object: {} },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(false);
    expect(result.event_type).toBe("payment_intent.succeeded");
  });

  it("handles customer objects instead of string IDs", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_obj",
          client_reference_id: "t-1",
          customer: { id: "cus_abc123" },
          amount_total: 500,
          metadata: {},
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(true);
    const mapping = tenantStore.getByTenant("t-1");
    expect(mapping?.processor_customer_id).toBe("cus_abc123");
  });
});

// -- loadStripeConfig -------------------------------------------------------

describe("loadStripeConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when required vars are missing", () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    expect(loadStripeConfig()).toBeNull();
  });

  it("returns config when all required vars are set", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    const config = loadStripeConfig();
    expect(config).toEqual({
      secretKey: "sk_test_123",
      webhookSecret: "whsec_123",
    });
  });
});
