import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initMeterSchema } from "../../monetization/metering/schema.js";
import { initStripeSchema } from "../../monetization/stripe/schema.js";
import { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";

// Set env var BEFORE importing billing routes so bearer auth uses this token
const TEST_TOKEN = "test-billing-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// Import AFTER env stub
const { billingRoutes, setBillingDeps } = await import("./billing.js");

function createTestDb() {
  const db = new BetterSqlite3(":memory:");
  initMeterSchema(db);
  initStripeSchema(db);
  return db;
}

function createMockStripe(
  overrides: {
    checkoutCreate?: ReturnType<typeof vi.fn>;
    portalCreate?: ReturnType<typeof vi.fn>;
    constructEvent?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    checkout: {
      sessions: {
        create:
          overrides.checkoutCreate ??
          vi.fn().mockResolvedValue({
            id: "cs_test_123",
            url: "https://checkout.stripe.com/cs_test_123",
          }),
      },
    },
    billingPortal: {
      sessions: {
        create:
          overrides.portalCreate ??
          vi.fn().mockResolvedValue({
            url: "https://billing.stripe.com/session_xyz",
          }),
      },
    },
    webhooks: {
      constructEvent: overrides.constructEvent ?? vi.fn(),
    },
  } as unknown as Stripe;
}

describe("billing routes", () => {
  let db: BetterSqlite3.Database;
  let stripe: Stripe;
  let tenantStore: TenantCustomerStore;

  beforeEach(() => {
    db = createTestDb();
    stripe = createMockStripe();
    tenantStore = new TenantCustomerStore(db);
    setBillingDeps({
      stripe,
      db,
      webhookSecret: "whsec_test_secret",
      defaultPriceId: "price_default",
    });
  });

  afterEach(() => {
    db.close();
  });

  // -- Authentication -------------------------------------------------------

  describe("authentication", () => {
    it("rejects checkout without bearer token", async () => {
      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          successUrl: "https://example.com/s",
          cancelUrl: "https://example.com/c",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects portal without bearer token", async () => {
      const res = await billingRoutes.request("/portal", {
        method: "POST",
        body: JSON.stringify({ tenant: "t-1", returnUrl: "https://example.com/billing" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects checkout with wrong token", async () => {
      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          successUrl: "https://example.com/s",
          cancelUrl: "https://example.com/c",
        }),
        headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("webhook does NOT require bearer auth (uses stripe signature)", async () => {
      // Webhook should not return 401 even without bearer token.
      // It should return 400 for missing stripe-signature header instead.
      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing stripe-signature header");
    });
  });

  // -- POST /checkout -------------------------------------------------------

  describe("POST /checkout", () => {
    it("creates checkout session and returns URL", async () => {
      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_custom",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://checkout.stripe.com/cs_test_123");
      expect(body.sessionId).toBe("cs_test_123");
    });

    it("uses default priceId when not provided", async () => {
      const checkoutCreate = vi
        .fn()
        .mockResolvedValue({ id: "cs_test_456", url: "https://checkout.stripe.com/cs_test_456" });
      const mockStripe = createMockStripe({ checkoutCreate });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test", defaultPriceId: "price_default" });

      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(checkoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: "price_default" }],
        }),
      );
    });

    it("returns 400 when no priceId and no default", async () => {
      setBillingDeps({ stripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Missing required fields");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: "not-json",
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 400 for invalid input (missing tenant)", async () => {
      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid input");
    });

    it("returns 400 for invalid input (bad tenant ID format)", async () => {
      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1; DROP TABLE",
          priceId: "price_abc",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid input");
    });

    it("returns 400 for invalid URLs", async () => {
      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_abc",
          successUrl: "not-a-url",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });

    it("returns 500 when Stripe API fails", async () => {
      const checkoutCreate = vi.fn().mockRejectedValue(new Error("Stripe is down"));
      const mockStripe = createMockStripe({ checkoutCreate });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test", defaultPriceId: "price_default" });

      const res = await billingRoutes.request("/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Stripe is down");
    });
  });

  // -- POST /portal ---------------------------------------------------------

  describe("POST /portal", () => {
    it("creates portal session and returns URL", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

      const portalCreate = vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/portal_123" });
      const mockStripe = createMockStripe({ portalCreate });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/portal", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          returnUrl: "https://example.com/billing",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://billing.stripe.com/portal_123");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await billingRoutes.request("/portal", {
        method: "POST",
        body: "not-json",
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 400 for invalid input (missing returnUrl)", async () => {
      const res = await billingRoutes.request("/portal", {
        method: "POST",
        body: JSON.stringify({ tenant: "t-1" }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid input");
    });

    it("returns 500 when tenant has no Stripe customer", async () => {
      const res = await billingRoutes.request("/portal", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-unknown",
          returnUrl: "https://example.com/billing",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("No Stripe customer found");
    });

    it("returns 500 when Stripe API fails", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

      const portalCreate = vi.fn().mockRejectedValue(new Error("Portal unavailable"));
      const mockStripe = createMockStripe({ portalCreate });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/portal", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          returnUrl: "https://example.com/billing",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Portal unavailable");
    });
  });

  // -- POST /webhook --------------------------------------------------------

  describe("POST /webhook", () => {
    it("returns 400 when stripe-signature header is missing", async () => {
      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing stripe-signature header");
    });

    it("returns 400 when signature verification fails", async () => {
      const constructEvent = vi.fn().mockImplementation(() => {
        throw new Error("Webhook signature verification failed");
      });
      const mockStripe = createMockStripe({ constructEvent });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=bad_sig" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid webhook signature");
    });

    it("processes valid webhook event and returns result", async () => {
      tenantStore.upsert({ tenant: "t-1", stripeCustomerId: "cus_abc123" });

      const validEvent: Stripe.Event = {
        type: "customer.subscription.updated",
        data: {
          object: { id: "sub_new", customer: "cus_abc123" },
        },
      } as unknown as Stripe.Event;

      const constructEvent = vi.fn().mockReturnValue(validEvent);
      const mockStripe = createMockStripe({ constructEvent });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: '{"type":"customer.subscription.updated"}',
        headers: { "stripe-signature": "t=123,v1=valid_sig" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.handled).toBe(true);
      expect(body.event_type).toBe("customer.subscription.updated");
      expect(body.tenant).toBe("t-1");

      // Verify constructEvent was called with correct args
      expect(constructEvent).toHaveBeenCalledWith(
        '{"type":"customer.subscription.updated"}',
        "t=123,v1=valid_sig",
        "whsec_test",
      );
    });

    it("handles checkout.session.completed via webhook", async () => {
      const checkoutEvent: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "t-new",
            customer: "cus_new",
            subscription: "sub_new",
            metadata: {},
          },
        },
      } as unknown as Stripe.Event;

      const constructEvent = vi.fn().mockReturnValue(checkoutEvent);
      const mockStripe = createMockStripe({ constructEvent });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.handled).toBe(true);
      expect(body.tenant).toBe("t-new");

      // Verify the tenant was persisted in the store
      const store = new TenantCustomerStore(db);
      const mapping = store.getByTenant("t-new");
      expect(mapping?.stripe_customer_id).toBe("cus_new");
      expect(mapping?.stripe_subscription_id).toBe("sub_new");
    });

    it("returns handled=false for unrecognized event types", async () => {
      const unknownEvent: Stripe.Event = {
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as unknown as Stripe.Event;

      const constructEvent = vi.fn().mockReturnValue(unknownEvent);
      const mockStripe = createMockStripe({ constructEvent });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.handled).toBe(false);
      expect(body.event_type).toBe("payment_intent.succeeded");
    });

    it("handles subscription deletion via webhook", async () => {
      tenantStore.upsert({
        tenant: "t-1",
        stripeCustomerId: "cus_abc123",
        stripeSubscriptionId: "sub_old",
        tier: "pro",
      });

      const deleteEvent: Stripe.Event = {
        type: "customer.subscription.deleted",
        data: {
          object: { id: "sub_old", customer: "cus_abc123" },
        },
      } as unknown as Stripe.Event;

      const constructEvent = vi.fn().mockReturnValue(deleteEvent);
      const mockStripe = createMockStripe({ constructEvent });
      setBillingDeps({ stripe: mockStripe, db, webhookSecret: "whsec_test" });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.handled).toBe(true);

      // Verify tenant was downgraded
      const store = new TenantCustomerStore(db);
      const mapping = store.getByTenant("t-1");
      expect(mapping?.tier).toBe("free");
      expect(mapping?.stripe_subscription_id).toBeNull();
    });
  });

  // -- GET /billing/usage ---------------------------------------------------

  describe("GET /billing/usage", () => {
    it("returns usage summaries for a tenant", async () => {
      // Insert some test meter events
      const now = Date.now();
      const windowStart = Math.floor(now / 60_000) * 60_000;

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-1", "t-1", "chat", "openai", 0.01, 0.015, windowStart + 1000, null, null);

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-2", "t-1", "embeddings", "openai", 0.001, 0.0015, windowStart + 2000, null, null);

      // Aggregate the events
      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      aggregator.aggregate(windowStart + 60_000);

      const res = await billingRoutes.request(`/usage?tenant=t-1`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("t-1");
      expect(body.usage).toHaveLength(2);
      expect(body.usage[0].capability).toMatch(/chat|embeddings/);
      expect(body.usage[0].provider).toBe("openai");
    });

    it("filters by capability", async () => {
      const now = Date.now();
      const windowStart = Math.floor(now / 60_000) * 60_000;

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-3", "t-2", "chat", "openai", 0.01, 0.015, windowStart + 1000, null, null);

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-4", "t-2", "voice", "elevenlabs", 0.02, 0.03, windowStart + 2000, null, null);

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      aggregator.aggregate(windowStart + 60_000);

      const res = await billingRoutes.request(`/usage?tenant=t-2&capability=chat`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage).toHaveLength(1);
      expect(body.usage[0].capability).toBe("chat");
    });

    it("filters by provider", async () => {
      const now = Date.now();
      const windowStart = Math.floor(now / 60_000) * 60_000;

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-5", "t-3", "chat", "openai", 0.01, 0.015, windowStart + 1000, null, null);

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-6", "t-3", "chat", "anthropic", 0.02, 0.03, windowStart + 2000, null, null);

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      aggregator.aggregate(windowStart + 60_000);

      const res = await billingRoutes.request(`/usage?tenant=t-3&provider=anthropic`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage).toHaveLength(1);
      expect(body.usage[0].provider).toBe("anthropic");
    });

    it("filters by date range", async () => {
      const now = Date.now();
      const window1 = Math.floor(now / 60_000) * 60_000;
      const window2 = window1 + 60_000;

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-7", "t-4", "chat", "openai", 0.01, 0.015, window1 + 1000, null, null);

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-8", "t-4", "chat", "openai", 0.02, 0.03, window2 + 1000, null, null);

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      aggregator.aggregate(window2 + 60_000);

      const res = await billingRoutes.request(`/usage?tenant=t-4&startDate=${window1}&endDate=${window1 + 60_000}`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage).toHaveLength(1);
      expect(body.usage[0].window_start).toBe(window1);
    });

    it("returns 401 without auth", async () => {
      const res = await billingRoutes.request(`/usage?tenant=t-1`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid tenant", async () => {
      const res = await billingRoutes.request(`/usage?tenant=invalid!@#`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid query parameters");
    });

    it("returns empty array for tenant with no usage", async () => {
      const res = await billingRoutes.request(`/usage?tenant=t-no-usage`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("t-no-usage");
      expect(body.usage).toEqual([]);
    });
  });

  // -- GET /billing/usage/summary -------------------------------------------

  describe("GET /billing/usage/summary", () => {
    it("returns total spend for a tenant", async () => {
      const now = Date.now();
      const windowStart = Math.floor(now / 60_000) * 60_000;

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-s1", "t-sum-1", "chat", "openai", 0.01, 0.015, windowStart + 1000, null, null);

      db.prepare(
        `INSERT INTO meter_events (id, tenant, capability, provider, cost, charge, timestamp, session_id, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-s2", "t-sum-1", "embeddings", "openai", 0.005, 0.0075, windowStart + 2000, null, null);

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      aggregator.aggregate(windowStart + 60_000);

      const res = await billingRoutes.request(`/usage/summary?tenant=t-sum-1&startDate=${windowStart}`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("t-sum-1");
      expect(body.period_start).toBe(windowStart);
      expect(body.total_cost).toBe(0.015);
      expect(body.total_charge).toBe(0.0225);
      expect(body.event_count).toBe(2);
    });

    it("defaults to current billing period", async () => {
      const res = await billingRoutes.request(`/usage/summary?tenant=t-sum-2`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("t-sum-2");
      expect(body.period_start).toBeTypeOf("number");
      expect(body.total_cost).toBe(0);
      expect(body.total_charge).toBe(0);
      expect(body.event_count).toBe(0);
    });

    it("returns 401 without auth", async () => {
      const res = await billingRoutes.request(`/usage/summary?tenant=t-sum-1`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 for missing tenant", async () => {
      const res = await billingRoutes.request(`/usage/summary`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid query parameters");
    });
  });

  // -- GET /billing/usage/history -------------------------------------------

  describe("GET /billing/usage/history", () => {
    it("returns historical billing reports", async () => {
      // Insert a test report
      db.prepare(
        `INSERT INTO stripe_usage_reports
          (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("report-1", "t-hist-1", "chat", "openai", 1000, 4600000, "wopr_chat_usage", 150, Date.now());

      const res = await billingRoutes.request(`/usage/history?tenant=t-hist-1`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("t-hist-1");
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0].event_name).toBe("wopr_chat_usage");
      expect(body.reports[0].value_cents).toBe(150);
    });

    it("respects limit parameter", async () => {
      // Insert multiple reports
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO stripe_usage_reports
            (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `report-limit-${i}`,
          "t-hist-2",
          "chat",
          "openai",
          i * 3600000,
          (i + 1) * 3600000,
          "wopr_chat_usage",
          100 + i,
          Date.now(),
        );
      }

      const res = await billingRoutes.request(`/usage/history?tenant=t-hist-2&limit=3`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reports).toHaveLength(3);
    });

    it("returns empty array for tenant with no reports", async () => {
      const res = await billingRoutes.request(`/usage/history?tenant=t-hist-no-reports`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("t-hist-no-reports");
      expect(body.reports).toEqual([]);
    });

    it("returns 401 without auth", async () => {
      const res = await billingRoutes.request(`/usage/history?tenant=t-hist-1`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid limit", async () => {
      const res = await billingRoutes.request(`/usage/history?tenant=t-hist-1&limit=2000`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid query parameters");
    });
  });
});
