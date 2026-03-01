import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents } from "../../db/schema/meter-events.js";
import { DrizzleAffiliateRepository } from "../../monetization/affiliate/drizzle-affiliate-repository.js";
import { CreditLedger } from "../../monetization/credits/credit-ledger.js";
import { TenantCustomerStore } from "../../monetization/index.js";
import { MeterAggregator } from "../../monetization/metering/aggregator.js";
import type { IPaymentProcessor } from "../../monetization/payment-processor.js";
import { PaymentMethodOwnershipError } from "../../monetization/payment-processor.js";
import { DrizzlePayRamChargeStore } from "../../monetization/payram/charge-store.js";
import { noOpReplayGuard } from "../../monetization/webhook-seen-repository.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleSigPenaltyRepository } from "../drizzle-sig-penalty-repository.js";
import type { ISigPenaltyRepository } from "../sig-penalty-repository.js";

// Set env vars BEFORE importing billing routes so bearer auth uses these tokens
const TEST_TOKEN = "test-billing-token";
const TEST_TENANT_TOKEN = "test-billing-tenant-t1-token";
const TEST_TENANT_UNKNOWN_TOKEN = "test-billing-tenant-unknown-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);
vi.stubEnv("FLEET_TOKEN_t-1", `admin:${TEST_TENANT_TOKEN}`);
vi.stubEnv("FLEET_TOKEN_t-unknown", `admin:${TEST_TENANT_UNKNOWN_TOKEN}`);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };
const tenantT1AuthHeader = { Authorization: `Bearer ${TEST_TENANT_TOKEN}` };
const tenantUnknownAuthHeader = { Authorization: `Bearer ${TEST_TENANT_UNKNOWN_TOKEN}` };

// Import AFTER env stub
const { billingRoutes, setBillingDeps } = await import("./billing.js");

function createTestSigPenaltyRepo(db: DrizzleDb): ISigPenaltyRepository {
  return new DrizzleSigPenaltyRepository(db);
}

async function createBillingTestDb(): Promise<{ db: DrizzleDb; pool: PGlite }> {
  return createTestDb();
}

function createMockProcessor(
  overrides: {
    createCheckoutSession?: ReturnType<typeof vi.fn>;
    createPortalSession?: ReturnType<typeof vi.fn>;
    handleWebhook?: ReturnType<typeof vi.fn>;
    setupPaymentMethod?: ReturnType<typeof vi.fn>;
    listPaymentMethods?: ReturnType<typeof vi.fn>;
    detachPaymentMethod?: ReturnType<typeof vi.fn>;
    supportsPortal?: boolean;
    charge?: ReturnType<typeof vi.fn>;
  } = {},
): IPaymentProcessor {
  return {
    name: "mock",
    supportsPortal: () => overrides.supportsPortal ?? true,
    createCheckoutSession: (overrides.createCheckoutSession ??
      vi.fn().mockResolvedValue({
        id: "cs_test_123",
        url: "https://pay.example.com/checkout/cs_test_123",
      })) as IPaymentProcessor["createCheckoutSession"],
    createPortalSession: (overrides.createPortalSession ??
      vi.fn().mockResolvedValue({
        url: "https://pay.example.com/portal/portal_123",
      })) as IPaymentProcessor["createPortalSession"],
    handleWebhook: (overrides.handleWebhook ??
      vi.fn().mockResolvedValue({ handled: false, eventType: "unknown" })) as IPaymentProcessor["handleWebhook"],
    setupPaymentMethod: (overrides.setupPaymentMethod ??
      vi
        .fn()
        .mockResolvedValue({ clientSecret: "seti_test_123_secret_abc" })) as IPaymentProcessor["setupPaymentMethod"],
    listPaymentMethods: (overrides.listPaymentMethods ??
      vi.fn().mockResolvedValue([])) as IPaymentProcessor["listPaymentMethods"],
    detachPaymentMethod: (overrides.detachPaymentMethod ??
      vi.fn().mockResolvedValue(undefined)) as IPaymentProcessor["detachPaymentMethod"],
    charge: (overrides.charge ?? vi.fn().mockResolvedValue({ success: true })) as IPaymentProcessor["charge"],
    getCustomerEmail: vi.fn().mockResolvedValue("") as IPaymentProcessor["getCustomerEmail"],
    updateCustomerEmail: vi.fn().mockResolvedValue(undefined) as IPaymentProcessor["updateCustomerEmail"],
    listInvoices: vi.fn().mockResolvedValue([]) as IPaymentProcessor["listInvoices"],
  };
}

describe("billing routes", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let processor: IPaymentProcessor;
  let tenantStore: TenantCustomerStore;
  let sigPenaltyRepo: ISigPenaltyRepository;

  beforeAll(async () => {
    const testDb = await createBillingTestDb();
    pool = testDb.pool;
    db = testDb.db;
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    processor = createMockProcessor();
    tenantStore = new TenantCustomerStore(db);
    sigPenaltyRepo = createTestSigPenaltyRepo(db);
    setBillingDeps({
      processor,
      creditLedger: new CreditLedger(db),
      meterAggregator: new MeterAggregator(db),
      sigPenaltyRepo,
      affiliateRepo: new DrizzleAffiliateRepository(db),
      replayGuard: noOpReplayGuard,
      payramReplayGuard: noOpReplayGuard,
    });
  });

  // -- Authentication -------------------------------------------------------

  describe("authentication", () => {
    it("rejects credits checkout without bearer token", async () => {
      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_test_credit_5",
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

    it("rejects credits checkout with wrong token", async () => {
      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_test_credit_5",
          successUrl: "https://example.com/s",
          cancelUrl: "https://example.com/c",
        }),
        headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("webhook does NOT require bearer auth (uses processor signature)", async () => {
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

  // -- POST /credits/checkout ------------------------------------------------

  describe("POST /credits/checkout", () => {
    it("creates credit checkout session and returns URL", async () => {
      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_test_credit_25",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://pay.example.com/checkout/cs_test_123");
      expect(body.sessionId).toBe("cs_test_123");
    });

    it("returns 400 when priceId is missing", async () => {
      const res = await billingRoutes.request("/credits/checkout", {
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
      expect(body.error).toBe("Invalid input");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: "not-json",
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 400 for invalid input (missing tenant)", async () => {
      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: JSON.stringify({
          priceId: "price_test_credit_5",
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
      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1; DROP TABLE",
          priceId: "price_test_credit_5",
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
      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_test_credit_5",
          successUrl: "not-a-url",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });

    it("returns 500 when processor API fails", async () => {
      const createCheckoutSession = vi.fn().mockRejectedValue(new Error("Payment processor unavailable"));
      setBillingDeps({
        processor: createMockProcessor({ createCheckoutSession }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/credits/checkout", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_test_credit_5",
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Payment processor unavailable");
    });
  });

  // -- POST /portal ---------------------------------------------------------

  describe("POST /portal", () => {
    it("creates portal session and returns URL", async () => {
      tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

      const createPortalSession = vi.fn().mockResolvedValue({ url: "https://pay.example.com/portal/portal_123" });
      setBillingDeps({
        processor: createMockProcessor({ createPortalSession }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

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
      expect(body.url).toBe("https://pay.example.com/portal/portal_123");
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

    it("returns 501 when processor does not support portal", async () => {
      setBillingDeps({
        processor: createMockProcessor({ supportsPortal: false }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });
      const res = await billingRoutes.request("/portal", {
        method: "POST",
        body: JSON.stringify({
          tenant: "t-unknown",
          returnUrl: "https://example.com/billing",
        }),
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toContain("not supported");
    });

    it("returns 500 when processor API fails", async () => {
      tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_abc123" });

      const createPortalSession = vi.fn().mockRejectedValue(new Error("Portal unavailable"));
      setBillingDeps({
        processor: createMockProcessor({ createPortalSession }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

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
      const handleWebhook = vi.fn().mockRejectedValue(new Error("Webhook signature verification failed"));
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=bad_sig" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid webhook signature");
    });

    it("processes checkout.session.completed and returns handled=true", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        handled: true,
        eventType: "checkout.session.completed",
        tenant: "t-new",
        creditedCents: 2500,
      });
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.handled).toBe(true);
      expect(body.tenant).toBe("t-new");
      expect(body.creditedCents).toBe(2500);
    });

    it("returns handled=false for subscription events (no longer handled)", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({ handled: false, eventType: "customer.subscription.updated" });
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.handled).toBe(false);
      expect(body.event_type).toBe("customer.subscription.updated");
    });

    it("rejects replayed webhook events with duplicate flag", async () => {
      // First call returns credited result; second call returns duplicate=true
      const handleWebhook = vi
        .fn()
        .mockResolvedValueOnce({
          handled: true,
          eventType: "checkout.session.completed",
          tenant: "t-replay",
          creditedCents: 500,
        })
        .mockResolvedValueOnce({
          handled: true,
          eventType: "checkout.session.completed",
          tenant: "t-replay",
          creditedCents: 500,
          duplicate: true,
        });
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      // First request — should process normally
      const res1 = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.handled).toBe(true);
      expect(body1.creditedCents).toBe(500);
      expect(body1.duplicate).toBeUndefined();

      // Replay — same event ID, should be flagged as duplicate
      const res2 = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });
      expect(res2.status).toBe(200); // Idempotent 200, not 4xx
      const body2 = await res2.json();
      expect(body2.handled).toBe(true);
      expect(body2.duplicate).toBe(true);
    });

    it("routes webhook body and signature to processor.handleWebhook", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({ handled: false, eventType: "payment_intent.succeeded" });
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });

      // Verify processor.handleWebhook was called with body buffer and signature
      expect(handleWebhook).toHaveBeenCalledWith(Buffer.from("raw-body"), "t=123,v1=valid");
    });

    it("returns handled=false for unrecognized event types", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({ handled: false, eventType: "payment_intent.succeeded" });
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

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

    it("returns 429 when IP has too many signature failures (exponential backoff)", async () => {
      const handleWebhook = vi.fn().mockRejectedValue(new Error("Webhook signature verification failed"));
      const sharedSigPenaltyRepo = createTestSigPenaltyRepo(db);
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: sharedSigPenaltyRepo,
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      // First failure: 400 (not yet blocked)
      const res1 = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=bad", "x-forwarded-for": "1.2.3.4" },
      });
      expect(res1.status).toBe(400);

      // Second request from same IP: should be blocked (429)
      const res2 = await billingRoutes.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=bad", "x-forwarded-for": "1.2.3.4" },
      });
      expect(res2.status).toBe(429);
      expect(res2.headers.get("Retry-After")).toBeTruthy();
    });

    it("does not penalize different IPs for another IP's failures", async () => {
      const handleWebhook = vi.fn().mockRejectedValue(new Error("sig fail"));
      const sharedSigPenaltyRepo = createTestSigPenaltyRepo(db);
      setBillingDeps({
        processor: createMockProcessor({ handleWebhook }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: sharedSigPenaltyRepo,
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      // Wrap billingRoutes in an app that injects socket address from XFF,
      // simulating real TCP connections from different clients.
      const wrapperApp = new Hono();
      wrapperApp.use("*", async (c, next) => {
        const xff = c.req.header("x-forwarded-for");
        const firstIp = xff?.split(",")[0]?.trim();
        if (firstIp) {
          // In test context c.env is undefined; assign it to simulate a real TCP socket.
          (c as { env: unknown }).env = { incoming: { socket: { remoteAddress: firstIp } } };
        }
        await next();
      });
      wrapperApp.route("/", billingRoutes);

      // Fail from IP-A
      await wrapperApp.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=bad", "x-forwarded-for": "10.0.0.1" },
      });

      // IP-B should not be affected (gets 400 from sig failure, not 429 from penalty)
      const res = await wrapperApp.request("/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=bad", "x-forwarded-for": "10.0.0.2" },
      });
      expect(res.status).toBe(400);
    });
  });

  // -- GET /billing/usage ---------------------------------------------------

  describe("GET /billing/usage", () => {
    it("returns usage summaries for a tenant", async () => {
      const now = Date.now();
      const windowStart = Math.floor(now / 60_000) * 60_000;

      await db.insert(meterEvents).values({
        id: "evt-1",
        tenant: "t-1",
        capability: "chat",
        provider: "openai",
        cost: 0.01,
        charge: 0.015,
        timestamp: windowStart + 1000,
        sessionId: null,
        duration: null,
      });

      await db.insert(meterEvents).values({
        id: "evt-2",
        tenant: "t-1",
        capability: "embeddings",
        provider: "openai",
        cost: 0.001,
        charge: 0.0015,
        timestamp: windowStart + 2000,
        sessionId: null,
        duration: null,
      });

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      await aggregator.aggregate(windowStart + 60_000);

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

      await db.insert(meterEvents).values({
        id: "evt-3",
        tenant: "t-2",
        capability: "chat",
        provider: "openai",
        cost: 0.01,
        charge: 0.015,
        timestamp: windowStart + 1000,
        sessionId: null,
        duration: null,
      });

      await db.insert(meterEvents).values({
        id: "evt-4",
        tenant: "t-2",
        capability: "voice",
        provider: "elevenlabs",
        cost: 0.02,
        charge: 0.03,
        timestamp: windowStart + 2000,
        sessionId: null,
        duration: null,
      });

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      await aggregator.aggregate(windowStart + 60_000);

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

      await db.insert(meterEvents).values({
        id: "evt-5",
        tenant: "t-3",
        capability: "chat",
        provider: "openai",
        cost: 0.01,
        charge: 0.015,
        timestamp: windowStart + 1000,
        sessionId: null,
        duration: null,
      });

      await db.insert(meterEvents).values({
        id: "evt-6",
        tenant: "t-3",
        capability: "chat",
        provider: "anthropic",
        cost: 0.02,
        charge: 0.03,
        timestamp: windowStart + 2000,
        sessionId: null,
        duration: null,
      });

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      await aggregator.aggregate(windowStart + 60_000);

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

      await db.insert(meterEvents).values({
        id: "evt-7",
        tenant: "t-4",
        capability: "chat",
        provider: "openai",
        cost: 0.01,
        charge: 0.015,
        timestamp: window1 + 1000,
        sessionId: null,
        duration: null,
      });

      await db.insert(meterEvents).values({
        id: "evt-8",
        tenant: "t-4",
        capability: "chat",
        provider: "openai",
        cost: 0.02,
        charge: 0.03,
        timestamp: window2 + 1000,
        sessionId: null,
        duration: null,
      });

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      await aggregator.aggregate(window2 + 60_000);

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

      await db.insert(meterEvents).values({
        id: "evt-s1",
        tenant: "t-sum-1",
        capability: "chat",
        provider: "openai",
        cost: 0.01,
        charge: 0.015,
        timestamp: windowStart + 1000,
        sessionId: null,
        duration: null,
      });

      await db.insert(meterEvents).values({
        id: "evt-s2",
        tenant: "t-sum-1",
        capability: "embeddings",
        provider: "openai",
        cost: 0.005,
        charge: 0.0075,
        timestamp: windowStart + 2000,
        sessionId: null,
        duration: null,
      });

      const { MeterAggregator } = await import("../../monetization/metering/aggregator.js");
      const aggregator = new MeterAggregator(db);
      await aggregator.aggregate(windowStart + 60_000);

      const res = await billingRoutes.request(`/usage/summary?tenant=t-sum-1&startDate=${windowStart}`, {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("t-sum-1");
      expect(body.period_start).toBe(windowStart);
      expect(body.total_cost).toBeCloseTo(0.015, 8);
      expect(body.total_charge).toBeCloseTo(0.0225, 8);
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

  // -- POST /crypto/checkout -------------------------------------------------

  describe("POST /crypto/checkout", () => {
    it("returns 503 when PayRam not configured (no env vars)", async () => {
      // By default in tests, PAYRAM_API_KEY and PAYRAM_BASE_URL are not set.
      const res = await billingRoutes.request("/crypto/checkout", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ tenant: "t-1", amountUsd: 25 }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("Crypto payments not configured");
    });

    it("requires bearer auth", async () => {
      const res = await billingRoutes.request("/crypto/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant: "t-1", amountUsd: 25 }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid JSON body (when PayRam is configured)", async () => {
      // Configure PayRam so that the JSON parsing path is reached
      vi.stubEnv("PAYRAM_API_KEY", "test-key");
      vi.stubEnv("PAYRAM_BASE_URL", "https://payram.example.com");
      setBillingDeps({
        processor: createMockProcessor(),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        payramChargeStore: new DrizzlePayRamChargeStore(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/crypto/checkout", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: "not-json",
      });

      vi.unstubAllEnvs();
      setBillingDeps({
        processor: createMockProcessor(),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      expect(res.status).toBe(400);
    });
  });

  // -- POST /crypto/webhook --------------------------------------------------

  describe("POST /crypto/webhook", () => {
    it("returns 503 when PayRam not configured (no env vars)", async () => {
      const res = await billingRoutes.request("/crypto/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference_id: "ref-001",
          status: "FILLED",
          amount: "25.00",
          currency: "USDC",
          filled_amount: "25.00",
        }),
      });

      expect(res.status).toBe(503);
    });

    it("does NOT require bearer auth (uses API key header)", async () => {
      // Without bearer auth, it should NOT return 401.
      // It should return 503 (not configured) or some other non-401 status.
      const res = await billingRoutes.request("/crypto/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(res.status).not.toBe(401);
    });
  });

  // -- POST /setup-intent ----------------------------------------------------

  describe("POST /setup-intent", () => {
    it("creates setup intent and returns client secret", async () => {
      const setupPaymentMethod = vi.fn().mockResolvedValue({ clientSecret: "seti_test_123_secret_abc" });
      setBillingDeps({
        processor: createMockProcessor({ setupPaymentMethod }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      // tenant is resolved from auth context (tokenTenantId), not from request body
      const res = await billingRoutes.request("/setup-intent", {
        method: "POST",
        headers: { ...tenantT1AuthHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.clientSecret).toBe("seti_test_123_secret_abc");
    });

    it("returns 401 without auth", async () => {
      const res = await billingRoutes.request("/setup-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid JSON body (no tenant in auth context)", async () => {
      // Legacy token (TEST_TOKEN) has no tenantId in context — route returns 400 Missing tenant
      // before it ever attempts to parse the body
      const res = await billingRoutes.request("/setup-intent", {
        method: "POST",
        body: "not-json",
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing tenant");
    });

    it("returns 400 for missing tenant", async () => {
      // Legacy token (TEST_TOKEN) has no tenantId in auth context — route returns 400 Missing tenant
      const res = await billingRoutes.request("/setup-intent", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing tenant");
    });

    it("returns 500 when processor throws (e.g. no customer found)", async () => {
      const setupPaymentMethod = vi.fn().mockRejectedValue(new Error("No customer found for tenant: t-unknown"));
      setBillingDeps({
        processor: createMockProcessor({ setupPaymentMethod }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/setup-intent", {
        method: "POST",
        headers: { ...tenantUnknownAuthHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("No customer found");
    });

    it("returns 500 when processor API call fails", async () => {
      const setupPaymentMethod = vi.fn().mockRejectedValue(new Error("Payment processor unavailable"));
      setBillingDeps({
        processor: createMockProcessor({ setupPaymentMethod }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      // tenant is resolved from auth context (tokenTenantId)
      const res = await billingRoutes.request("/setup-intent", {
        method: "POST",
        headers: { ...tenantT1AuthHeader, "Content-Type": "application/json" },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Payment processor unavailable");
    });
  });

  // -- DELETE /payment-methods/:id -------------------------------------------

  describe("DELETE /payment-methods/:id", () => {
    it("detaches payment method and returns removed=true", async () => {
      const detachPaymentMethod = vi.fn().mockResolvedValue(undefined);
      setBillingDeps({
        processor: createMockProcessor({ detachPaymentMethod }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/payment-methods/pm_test_123?tenant=t-1", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.removed).toBe(true);
    });

    it("returns 401 without auth", async () => {
      const res = await billingRoutes.request("/payment-methods/pm_test_123?tenant=t-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid payment method ID format", async () => {
      const res = await billingRoutes.request("/payment-methods/invalid_id?tenant=t-1", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid payment method ID");
    });

    it("returns 403 when payment method belongs to another tenant", async () => {
      const detachPaymentMethod = vi.fn().mockRejectedValue(new PaymentMethodOwnershipError());
      setBillingDeps({
        processor: createMockProcessor({ detachPaymentMethod }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/payment-methods/pm_test_123?tenant=t-1", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("does not belong");
    });

    it("returns 500 when processor API call fails", async () => {
      const detachPaymentMethod = vi.fn().mockRejectedValue(new Error("Payment processor error"));
      setBillingDeps({
        processor: createMockProcessor({ detachPaymentMethod }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: createTestSigPenaltyRepo(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        replayGuard: noOpReplayGuard,
        payramReplayGuard: noOpReplayGuard,
      });

      const res = await billingRoutes.request("/payment-methods/pm_test_123?tenant=t-1", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Payment processor error");
    });
  });

  // -- GET /billing/affiliate ------------------------------------------------

  describe("GET /affiliate", () => {
    it("returns affiliate code and stats for tenant", async () => {
      const res = await billingRoutes.request("/affiliate?tenant=t-1", {
        method: "GET",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.code).toMatch(/^[a-z0-9]{6}$/);
      expect(body.link).toContain("?ref=");
      expect(body.referrals_total).toBe(0);
      expect(body.referrals_converted).toBe(0);
      expect(body.creditsEarned).toBe(0);
    });

    it("returns same code on subsequent calls", async () => {
      const res1 = await billingRoutes.request("/affiliate?tenant=t-1", {
        method: "GET",
        headers: authHeader,
      });
      const body1 = await res1.json();

      const res2 = await billingRoutes.request("/affiliate?tenant=t-1", {
        method: "GET",
        headers: authHeader,
      });
      const body2 = await res2.json();

      expect(body1.code).toBe(body2.code);
    });

    it("returns 401 without auth", async () => {
      const res = await billingRoutes.request("/affiliate?tenant=t-1", {
        method: "GET",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for missing tenant", async () => {
      const res = await billingRoutes.request("/affiliate", {
        method: "GET",
        headers: authHeader,
      });
      expect(res.status).toBe(400);
    });
  });

  // -- POST /billing/affiliate/record-referral --------------------------------

  describe("POST /affiliate/record-referral", () => {
    it("records a referral with valid code", async () => {
      // First create a code for the referrer
      const codeRes = await billingRoutes.request("/affiliate?tenant=t-1", {
        method: "GET",
        headers: authHeader,
      });
      const { code } = await codeRes.json();

      const res = await billingRoutes.request("/affiliate/record-referral", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ code, referredTenantId: "new-user-1" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.recorded).toBe(true);
      expect(body.referrer).toBe("t-1");
    });

    it("returns 404 for unknown code", async () => {
      const res = await billingRoutes.request("/affiliate/record-referral", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ code: "nope00", referredTenantId: "new-user-1" }),
      });

      expect(res.status).toBe(404);
    });

    it("returns recorded=false for duplicate attribution", async () => {
      const codeRes = await billingRoutes.request("/affiliate?tenant=t-1", {
        method: "GET",
        headers: authHeader,
      });
      const { code } = await codeRes.json();

      await billingRoutes.request("/affiliate/record-referral", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ code, referredTenantId: "new-user-2" }),
      });

      const res = await billingRoutes.request("/affiliate/record-referral", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ code, referredTenantId: "new-user-2" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.recorded).toBe(false);
    });

    it("returns 401 without auth", async () => {
      const res = await billingRoutes.request("/affiliate/record-referral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "abc123", referredTenantId: "new-user-1" }),
      });
      expect(res.status).toBe(401);
    });
  });
});
