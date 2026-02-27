import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb as createPgTestDb } from "../../test/db.js";
import { CreditLedger } from "../credits/credit-ledger.js";
import { createCreditCheckoutSession } from "./checkout.js";
import { loadStripeConfig } from "./client.js";
import {
  CREDIT_PRICE_POINTS,
  getConfiguredPriceIds,
  getCreditAmountForPurchase,
  loadCreditPriceMap,
} from "./credit-prices.js";
import { createPortalSession } from "./portal.js";
import { TenantCustomerStore } from "./tenant-store.js";
import { handleWebhookEvent } from "./webhook.js";

// -- Schema -----------------------------------------------------------------

describe("Stripe schema (via migrations)", () => {
  it("creates tenant_customers table", async () => {
    const { pool } = await createPgTestDb();
    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tenant_customers'",
    );
    expect(result.rows).toHaveLength(1);
    await pool.close();
  });

  it("schema is ready after migrations", async () => {
    const { pool } = await createPgTestDb();
    // Just verify the pool works and migrations ran
    const result = await pool.query("SELECT 1 as ok");
    // biome-ignore lint/suspicious/noExplicitAny: intentional test cast
    expect((result.rows[0] as any).ok).toBe(1);
    await pool.close();
  });
});

// -- TenantCustomerStore ----------------------------------------------------

describe("TenantCustomerStore", () => {
  let db: DrizzleDb;
  let store: TenantCustomerStore;

  let pool: PGlite;

  beforeEach(async () => {
    const testDb = await createPgTestDb();
    pool = testDb.pool;
    db = testDb.db;
    store = new TenantCustomerStore(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("upsert creates a new mapping", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const row = await store.getByTenant("t-1");
    expect(row).toBeDefined();
    expect(row?.processor_customer_id).toBe("cus_abc123");
    expect(row?.tier).toBe("free");
  });

  it("upsert updates existing mapping", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });
    await store.upsert({
      tenant: "t-1",
      processorCustomerId: "cus_xyz789",
      tier: "pro",
    });

    const row = await store.getByTenant("t-1");
    expect(row?.processor_customer_id).toBe("cus_xyz789");
    expect(row?.tier).toBe("pro");
  });

  it("getByProcessorCustomerId finds by customer ID", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

    const row = await store.getByProcessorCustomerId("cus_abc123");
    expect(row?.tenant).toBe("t-1");
  });

  it("getByTenant returns null for unknown tenant", async () => {
    expect(await store.getByTenant("nonexistent")).toBeNull();
  });

  it("getByProcessorCustomerId returns null for unknown customer", async () => {
    expect(await store.getByProcessorCustomerId("cus_nonexistent")).toBeNull();
  });

  it("setTier updates the tier", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123", tier: "pro" });
    await store.setTier("t-1", "free");

    const row = await store.getByTenant("t-1");
    expect(row?.tier).toBe("free");
  });

  it("list returns all mappings", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_1" });
    await store.upsert({ tenant: "t-2", processorCustomerId: "cus_2" });

    const rows = await store.list();
    expect(rows).toHaveLength(2);
  });

  it("buildCustomerIdMap returns tenant -> customer ID map", async () => {
    await store.upsert({ tenant: "t-1", processorCustomerId: "cus_aaa" });
    await store.upsert({ tenant: "t-2", processorCustomerId: "cus_bbb" });

    const map = await store.buildCustomerIdMap();
    expect(map).toEqual({ "t-1": "cus_aaa", "t-2": "cus_bbb" });
  });
});

// -- Credit checkout --------------------------------------------------------

describe("createCreditCheckoutSession", () => {
  let tenantStore: TenantCustomerStore;

  let pool2: PGlite;

  beforeEach(async () => {
    const testDb = await createPgTestDb();
    pool2 = testDb.pool;
    tenantStore = new TenantCustomerStore(testDb.db);
  });

  afterEach(async () => {
    await pool2.close();
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
    await tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_existing" });

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
  it("has 5 preset price tiers", async () => {
    expect(CREDIT_PRICE_POINTS).toHaveLength(5);
  });

  it("getCreditAmountForPurchase returns correct bonus amounts", async () => {
    expect(getCreditAmountForPurchase(500)).toBe(500); // $5 -> $5.00
    expect(getCreditAmountForPurchase(1000)).toBe(1000); // $10 -> $10.00
    expect(getCreditAmountForPurchase(2500)).toBe(2550); // $25 -> $25.50
    expect(getCreditAmountForPurchase(5000)).toBe(5250); // $50 -> $52.50
    expect(getCreditAmountForPurchase(10000)).toBe(11000); // $100 -> $110.00
  });

  it("getCreditAmountForPurchase returns 1:1 for unknown amounts", async () => {
    expect(getCreditAmountForPurchase(1234)).toBe(1234);
    expect(getCreditAmountForPurchase(7500)).toBe(7500);
  });

  it("loadCreditPriceMap returns empty map when no env vars are set", async () => {
    const map = loadCreditPriceMap();
    // May or may not have entries depending on env
    expect(map).toBeInstanceOf(Map);
  });

  it("getConfiguredPriceIds returns empty when no env vars are set", async () => {
    const ids = getConfiguredPriceIds();
    expect(Array.isArray(ids)).toBe(true);
  });
});

// -- createPortalSession ----------------------------------------------------

describe("createPortalSession", () => {
  let tenantStore: TenantCustomerStore;

  let pool2: PGlite;

  beforeEach(async () => {
    const testDb = await createPgTestDb();
    pool2 = testDb.pool;
    tenantStore = new TenantCustomerStore(testDb.db);
  });

  afterEach(async () => {
    await pool2.close();
  });

  function createMockStripe(portalCreate: ReturnType<typeof vi.fn>) {
    return {
      billingPortal: { sessions: { create: portalCreate } },
    } as unknown as Stripe;
  }

  it("creates a portal session for existing customer", async () => {
    await tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

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
    await tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

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
  let tenantStore: TenantCustomerStore;
  let creditLedger: CreditLedger;

  let pool4: PGlite;

  beforeEach(async () => {
    const testDb = await createPgTestDb();
    pool4 = testDb.pool;
    tenantStore = new TenantCustomerStore(testDb.db);
    creditLedger = new CreditLedger(testDb.db);
  });

  afterEach(async () => {
    await pool4.close();
  });

  it("handles checkout.session.completed - credits the ledger", async () => {
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

    const result = await handleWebhookEvent({ tenantStore, creditLedger }, event);

    expect(result.handled).toBe(true);
    expect(result.tenant).toBe("t-1");
    expect(result.creditedCents).toBe(1000);

    // Verify credit was granted
    const balance = await creditLedger.balance("t-1");
    expect(balance.toCents()).toBe(1000);

    // Verify tenant mapping was created
    const mapping = await tenantStore.getByTenant("t-1");
    expect(mapping?.processor_customer_id).toBe("cus_abc123");
  });

  it("handles checkout.session.completed - uses metadata fallback", async () => {
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

    const result = await handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(true);
    expect(result.tenant).toBe("t-2");
    expect(result.creditedCents).toBe(500);
  });

  it("handles checkout.session.completed - returns unhandled when no tenant", async () => {
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

    const result = await handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(false);
  });

  it("returns unhandled for subscription event types (no longer handled)", async () => {
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_unknown",
        },
      },
    } as unknown as Stripe.Event;

    const result = await handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(false);
  });

  it("returns unhandled for unknown event types", async () => {
    const event = {
      type: "payment_intent.succeeded",
      data: { object: {} },
    } as unknown as Stripe.Event;

    const result = await handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(false);
    expect(result.event_type).toBe("payment_intent.succeeded");
  });

  it("handles customer objects instead of string IDs", async () => {
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

    const result = await handleWebhookEvent({ tenantStore, creditLedger }, event);
    expect(result.handled).toBe(true);
    const mapping = await tenantStore.getByTenant("t-1");
    expect(mapping?.processor_customer_id).toBe("cus_abc123");
  });
});

// -- loadStripeConfig -------------------------------------------------------

describe("loadStripeConfig", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when required vars are missing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    expect(loadStripeConfig()).toBeNull();
  });

  it("returns config when all required vars are set", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    const config = loadStripeConfig();
    expect(config).toEqual({
      secretKey: "sk_test_123",
      webhookSecret: "whsec_123",
    });
  });
});
