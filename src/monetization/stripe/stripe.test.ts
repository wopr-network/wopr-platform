import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeterEmitter } from "../metering/emitter.js";
import { initMeterSchema } from "../metering/schema.js";
import type { MeterEvent } from "../metering/types.js";
import { UsageAggregationWorker } from "../metering/usage-aggregation-worker.js";
import { loadStripeConfig } from "./client.js";
import { initStripeSchema } from "./schema.js";
import { TenantCustomerStore } from "./tenant-store.js";
import { StripeUsageReporter } from "./usage-reporter.js";
import { handleWebhookEvent } from "./webhook.js";

function createTestDb() {
  const db = new BetterSqlite3(":memory:");
  initMeterSchema(db);
  initStripeSchema(db);
  return db;
}

function makeEvent(overrides: Partial<MeterEvent> = {}): MeterEvent {
  return {
    tenant: "tenant-1",
    cost: 0.001,
    charge: 0.002,
    capability: "embeddings",
    provider: "openai",
    timestamp: Date.now(),
    ...overrides,
  };
}

// -- Schema -----------------------------------------------------------------

describe("initStripeSchema", () => {
  it("creates tenant_customers table", () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_customers'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates stripe_usage_reports table", () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stripe_usage_reports'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tenant_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(1);

    const stripeIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_stripe_%'")
      .all() as { name: string }[];
    expect(stripeIndexes.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    initStripeSchema(db);
    initStripeSchema(db);
    db.close();
  });
});

// -- TenantCustomerStore ----------------------------------------------------

describe("TenantCustomerStore", () => {
  let db: BetterSqlite3.Database;
  let store: TenantCustomerStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TenantCustomerStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("upsert creates a new mapping", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

    const row = store.getByTenant("t-1");
    expect(row).toBeDefined();
    expect(row?.stripe_customer_id).toBe("cus_abc123");
    expect(row?.tier).toBe("free");
    expect(row?.stripe_subscription_id).toBeNull();
  });

  it("upsert updates existing mapping", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });
    store.upsert({
      tenant: "t-1",
      stripeCustomerId: "cus_xyz789",
      stripeSubscriptionId: "sub_123",
      tier: "pro",
    });

    const row = store.getByTenant("t-1");
    expect(row?.stripe_customer_id).toBe("cus_xyz789");
    expect(row?.stripe_subscription_id).toBe("sub_123");
    expect(row?.tier).toBe("pro");
  });

  it("getByStripeCustomerId finds by customer ID", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

    const row = store.getByStripeCustomerId("cus_abc123");
    expect(row?.tenant).toBe("t-1");
  });

  it("getByTenant returns null for unknown tenant", () => {
    expect(store.getByTenant("nonexistent")).toBeNull();
  });

  it("getByStripeCustomerId returns null for unknown customer", () => {
    expect(store.getByStripeCustomerId("cus_nonexistent")).toBeNull();
  });

  it("setSubscription updates subscription ID", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });
    store.setSubscription("t-1", "sub_new456");

    const row = store.getByTenant("t-1");
    expect(row?.stripe_subscription_id).toBe("sub_new456");
  });

  it("setTier updates the tier", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123", tier: "pro" });
    store.setTier("t-1", "free");

    const row = store.getByTenant("t-1");
    expect(row?.tier).toBe("free");
  });

  it("list returns all mappings", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_1" });
    store.upsert({ tenant: "t-2", stripeCustomerId: "cus_2" });

    const rows = store.list();
    expect(rows).toHaveLength(2);
  });

  it("buildCustomerIdMap returns tenant -> customer ID map", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_aaa" });
    store.upsert({ tenant: "t-2", stripeCustomerId: "cus_bbb" });

    const map = store.buildCustomerIdMap();
    expect(map).toEqual({ "t-1": "cus_aaa", "t-2": "cus_bbb" });
  });

  it("upsert preserves subscription when not provided", () => {
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc", stripeSubscriptionId: "sub_123" });
    store.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc" });

    const row = store.getByTenant("t-1");
    expect(row?.stripe_subscription_id).toBe("sub_123");
  });
});

// -- StripeUsageReporter ----------------------------------------------------

describe("StripeUsageReporter", () => {
  let db: BetterSqlite3.Database;
  let emitter: MeterEmitter;
  let worker: UsageAggregationWorker;
  let tenantStore: TenantCustomerStore;

  const BILLING_PERIOD = 300_000; // 5 minutes

  function createMockStripe(meterEventsCreate: ReturnType<typeof vi.fn>) {
    return {
      billing: {
        meterEvents: {
          create: meterEventsCreate,
        },
      },
    } as unknown as Stripe;
  }

  beforeEach(() => {
    db = createTestDb();
    emitter = new MeterEmitter(db, { flushIntervalMs: 60_000 });
    worker = new UsageAggregationWorker(db, {
      periodMs: BILLING_PERIOD,
      lateArrivalGraceMs: BILLING_PERIOD,
    });
    tenantStore = new TenantCustomerStore(db);
  });

  afterEach(() => {
    worker.stop();
    emitter.close();
    db.close();
  });

  it("reports unreported billing periods to Stripe", async () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    // Set up tenant mapping.
    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_stripe_t1" });

    // Emit and aggregate usage.
    emitter.emit(makeEvent({ tenant: "t-1", charge: 0.5, timestamp: periodStart + 10_000 }));
    emitter.flush();
    worker.aggregate(now);

    const mockCreate = vi.fn().mockResolvedValue({ identifier: "mevt_123" });
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    const count = await reporter.report();

    expect(count).toBe(1);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "wopr_embeddings_usage",
        payload: expect.objectContaining({
          stripe_customer_id: "cus_stripe_t1",
          value: "50", // 0.50 * 100 = 50 cents
        }),
      }),
    );
  });

  it("does not re-report already reported periods", async () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_stripe_t1" });

    emitter.emit(makeEvent({ tenant: "t-1", charge: 0.5, timestamp: periodStart + 10_000 }));
    emitter.flush();
    worker.aggregate(now);

    const mockCreate = vi.fn().mockResolvedValue({ identifier: "mevt_123" });
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    await reporter.report();
    const secondCount = await reporter.report();

    expect(secondCount).toBe(0);
    expect(mockCreate).toHaveBeenCalledOnce(); // Not called again.
  });

  it("skips tenants without Stripe customer mapping", async () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    // No tenant mapping set up.
    emitter.emit(makeEvent({ tenant: "t-1", charge: 0.5, timestamp: periodStart + 10_000 }));
    emitter.flush();
    worker.aggregate(now);

    const mockCreate = vi.fn();
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    const count = await reporter.report();
    expect(count).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 0 when no unreported periods exist", async () => {
    const mockCreate = vi.fn();
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    const count = await reporter.report();
    expect(count).toBe(0);
  });

  it("reports multiple capabilities separately", async () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_stripe_t1" });

    emitter.emit(makeEvent({ tenant: "t-1", capability: "embeddings", charge: 0.5, timestamp: periodStart + 10_000 }));
    emitter.emit(makeEvent({ tenant: "t-1", capability: "voice", charge: 1.0, timestamp: periodStart + 20_000 }));
    emitter.flush();
    worker.aggregate(now);

    const mockCreate = vi.fn().mockResolvedValue({ identifier: "mevt_123" });
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    const count = await reporter.report();
    expect(count).toBe(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("stops on first API error to avoid hammering", async () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_stripe_t1" });

    emitter.emit(makeEvent({ tenant: "t-1", capability: "embeddings", charge: 0.5, timestamp: periodStart + 10_000 }));
    emitter.emit(makeEvent({ tenant: "t-1", capability: "voice", charge: 1.0, timestamp: periodStart + 20_000 }));
    emitter.flush();
    worker.aggregate(now);

    const mockCreate = vi.fn().mockRejectedValue(new Error("Stripe API error"));
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    const count = await reporter.report();
    expect(count).toBe(0);
    expect(mockCreate).toHaveBeenCalledOnce(); // Stopped after first error.
  });

  it("queryReports returns reported entries", async () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_stripe_t1" });

    emitter.emit(makeEvent({ tenant: "t-1", charge: 0.5, timestamp: periodStart + 10_000 }));
    emitter.flush();
    worker.aggregate(now);

    const mockCreate = vi.fn().mockResolvedValue({ identifier: "mevt_123" });
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    await reporter.report();

    const reports = reporter.queryReports("t-1");
    expect(reports).toHaveLength(1);
    expect(reports[0].tenant).toBe("t-1");
    expect(reports[0].event_name).toBe("wopr_embeddings_usage");
    expect(reports[0].value_cents).toBe(50);
  });

  it("marks zero-value periods as reported without calling Stripe", async () => {
    const now = Date.now();
    const periodStart = Math.floor(now / BILLING_PERIOD) * BILLING_PERIOD - 2 * BILLING_PERIOD;

    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_stripe_t1" });

    emitter.emit(makeEvent({ tenant: "t-1", charge: 0.0, timestamp: periodStart + 10_000 }));
    emitter.flush();
    worker.aggregate(now);

    const mockCreate = vi.fn().mockResolvedValue({ identifier: "mevt_123" });
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore);

    const count = await reporter.report();
    expect(count).toBe(1); // Marked as reported
    expect(mockCreate).not.toHaveBeenCalled(); // But didn't call Stripe
  });

  it("start/stop manages the periodic timer", () => {
    const mockCreate = vi.fn();
    const stripe = createMockStripe(mockCreate);
    const reporter = new StripeUsageReporter(db, stripe, tenantStore, { intervalMs: 60_000 });

    reporter.start();
    reporter.start(); // Idempotent
    reporter.stop();
    reporter.stop(); // Safe to call twice
  });
});

// -- Webhook ----------------------------------------------------------------

describe("handleWebhookEvent", () => {
  let db: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;

  beforeEach(() => {
    db = createTestDb();
    tenantStore = new TenantCustomerStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("handles checkout.session.completed - creates tenant mapping", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "t-1",
          customer: "cus_abc123",
          subscription: "sub_xyz789",
          metadata: {},
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);

    expect(result.handled).toBe(true);
    expect(result.tenant).toBe("t-1");

    const mapping = tenantStore.getByTenant("t-1");
    expect(mapping?.stripe_customer_id).toBe("cus_abc123");
    expect(mapping?.stripe_subscription_id).toBe("sub_xyz789");
  });

  it("handles checkout.session.completed - uses metadata fallback", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: null,
          customer: "cus_abc123",
          subscription: "sub_xyz789",
          metadata: { wopr_tenant: "t-2" },
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);
    expect(result.handled).toBe(true);
    expect(result.tenant).toBe("t-2");
  });

  it("handles checkout.session.completed - returns unhandled when no tenant", () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: null,
          customer: "cus_abc123",
          subscription: "sub_xyz789",
          metadata: {},
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);
    expect(result.handled).toBe(false);
  });

  it("handles customer.subscription.updated", () => {
    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123", stripeSubscriptionId: "sub_old" });

    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_new",
          customer: "cus_abc123",
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);
    expect(result.handled).toBe(true);
    expect(result.tenant).toBe("t-1");

    const mapping = tenantStore.getByTenant("t-1");
    expect(mapping?.stripe_subscription_id).toBe("sub_new");
  });

  it("handles customer.subscription.deleted - resets to free tier", () => {
    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123", tier: "pro" });

    const event = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_old",
          customer: "cus_abc123",
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);
    expect(result.handled).toBe(true);

    const mapping = tenantStore.getByTenant("t-1");
    expect(mapping?.tier).toBe("free");
  });

  it("returns unhandled for unknown event types", () => {
    const event = {
      type: "payment_intent.succeeded",
      data: { object: {} },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);
    expect(result.handled).toBe(false);
    expect(result.event_type).toBe("payment_intent.succeeded");
  });

  it("returns unhandled for subscription events with unknown customer", () => {
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_unknown",
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);
    expect(result.handled).toBe(false);
  });

  it("handles customer objects instead of string IDs", () => {
    tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_new",
          customer: { id: "cus_abc123" },
        },
      },
    } as unknown as Stripe.Event;

    const result = handleWebhookEvent(tenantStore, event);
    expect(result.handled).toBe(true);
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
    process.env.STRIPE_DEFAULT_PRICE_ID = "price_123";

    const config = loadStripeConfig();
    expect(config).toEqual({
      secretKey: "sk_test_123",
      webhookSecret: "whsec_123",
      defaultPriceId: "price_123",
    });
  });

  it("returns config without optional defaultPriceId", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";
    delete process.env.STRIPE_DEFAULT_PRICE_ID;

    const config = loadStripeConfig();
    expect(config).not.toBeNull();
    expect(config?.defaultPriceId).toBeUndefined();
  });
});
