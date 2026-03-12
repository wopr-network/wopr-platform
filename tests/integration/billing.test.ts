/**
 * Integration tests for /api/billing/* routes (credit purchase model, WOP-406).
 *
 * Tests billing endpoints through the full composed Hono app.
 * Uses in-memory PGlite for the tenant store and mocked IPaymentProcessor.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";
import { createTestDb, truncateAllTables } from "@wopr-network/platform-core/test/db"
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";

const { app } = await import("../../src/api/app.js");
const { setBillingDeps } = await import("../../src/api/routes/billing.js");
const { DrizzleSigPenaltyRepository } = await import("@wopr-network/platform-core/api/drizzle-sig-penalty-repository");
const { CreditLedger } = await import("@wopr-network/platform-core");
const { MeterAggregator } = await import("@wopr-network/platform-core/metering");
const { DrizzleUsageSummaryRepository } = await import("@wopr-network/platform-core/metering");
const { TenantCustomerRepository } = await import("@wopr-network/platform-core/monetization/index");
import type { IPaymentProcessor } from "@wopr-network/platform-core/monetization/payment-processor";
const { DrizzleAffiliateRepository } = await import("@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository");

async function createTestSigPenaltyRepo() {
  const { db } = await createTestDb();
  return new DrizzleSigPenaltyRepository(db);
}

function createMockProcessor(overrides: Partial<IPaymentProcessor> = {}): IPaymentProcessor {
  return {
    name: "mock",
    supportsPortal: () => true,
    createCheckoutSession: vi.fn().mockResolvedValue({
      id: "cs_test_123",
      url: "https://pay.example.com/checkout/cs_test_123",
    }) as IPaymentProcessor["createCheckoutSession"],
    createPortalSession: vi.fn().mockResolvedValue({
      url: "https://pay.example.com/portal/session_xyz",
    }) as IPaymentProcessor["createPortalSession"],
    handleWebhook: vi.fn().mockResolvedValue({
      handled: false,
      eventType: "unknown",
    }) as IPaymentProcessor["handleWebhook"],
    setupPaymentMethod: vi.fn().mockResolvedValue({ clientSecret: "seti_test" }) as IPaymentProcessor["setupPaymentMethod"],
    listPaymentMethods: vi.fn().mockResolvedValue([]) as IPaymentProcessor["listPaymentMethods"],
    detachPaymentMethod: vi.fn().mockResolvedValue(undefined) as IPaymentProcessor["detachPaymentMethod"],
    charge: vi.fn().mockResolvedValue({ success: true }) as IPaymentProcessor["charge"],
    ...overrides,
  };
}

describe("integration: billing routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let tenantRepo: InstanceType<typeof TenantCustomerRepository>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ db, pool } = await createTestDb());
    tenantRepo = new TenantCustomerRepository(db);
    setBillingDeps({
      processor: createMockProcessor(),
      creditLedger: new CreditLedger(db),
      meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
      sigPenaltyRepo: await createTestSigPenaltyRepo(),
      affiliateRepo: new DrizzleAffiliateRepository(db),
    });
  });

  afterEach(async () => {
    await pool.close();
  });

  // -- Authentication -------------------------------------------------------

  describe("auth middleware", () => {
    it("rejects /api/billing/credits/checkout without token", async () => {
      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_abc",
          successUrl: "https://app.wopr.bot/s",
          cancelUrl: "https://app.wopr.bot/c",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects /api/billing/portal without token", async () => {
      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant: "t-1", returnUrl: "https://app.wopr.bot" }),
      });
      expect(res.status).toBe(401);
    });

    it("/api/billing/webhook does NOT require bearer auth", async () => {
      // Webhook uses processor signature verification, not bearer auth.
      // Should return 400 (missing signature), NOT 401.
      const res = await app.request("/api/billing/webhook", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing stripe-signature header");
    });
  });

  // -- POST /api/billing/credits/checkout ------------------------------------

  describe("POST /api/billing/credits/checkout", () => {
    it("creates checkout session with valid input", async () => {
      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_abc",
          successUrl: "https://app.wopr.bot/success",
          cancelUrl: "https://app.wopr.bot/cancel",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://pay.example.com/checkout/cs_test_123");
      expect(body.sessionId).toBe("cs_test_123");
    });

    it("returns 400 for missing tenant", async () => {
      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          priceId: "price_abc",
          successUrl: "https://app.wopr.bot/s",
          cancelUrl: "https://app.wopr.bot/c",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid tenant ID (injection attempt)", async () => {
      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "t-1; DROP TABLE",
          priceId: "price_abc",
          successUrl: "https://app.wopr.bot/s",
          cancelUrl: "https://app.wopr.bot/c",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid URLs", async () => {
      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_abc",
          successUrl: "not-a-url",
          cancelUrl: "https://app.wopr.bot/c",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 500 when processor fails", async () => {
      setBillingDeps({
        processor: createMockProcessor({
          createCheckoutSession: vi.fn().mockRejectedValue(new Error("Payment processor unavailable")) as IPaymentProcessor["createCheckoutSession"],
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_abc",
          successUrl: "https://app.wopr.bot/s",
          cancelUrl: "https://app.wopr.bot/c",
        }),
      });
      expect(res.status).toBe(500);
    });
  });

  // -- POST /api/billing/portal ---------------------------------------------

  describe("POST /api/billing/portal", () => {
    it("creates portal session with valid input", async () => {
      setBillingDeps({
        processor: createMockProcessor({
          createPortalSession: vi.fn().mockResolvedValue({ url: "https://pay.example.com/portal/session" }) as IPaymentProcessor["createPortalSession"],
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "t-1",
          returnUrl: "https://app.wopr.bot/billing",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://pay.example.com/portal/session");
    });

    it("returns 501 when processor does not support portal", async () => {
      setBillingDeps({
        processor: createMockProcessor({
          supportsPortal: () => false,
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "unknown-tenant",
          returnUrl: "https://app.wopr.bot/billing",
        }),
      });
      expect(res.status).toBe(501);
    });

    it("returns 400 for missing returnUrl", async () => {
      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tenant: "t-1" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // -- POST /api/billing/webhook --------------------------------------------

  describe("POST /api/billing/webhook", () => {
    it("returns 400 when stripe-signature is missing", async () => {
      const res = await app.request("/api/billing/webhook", {
        method: "POST",
        body: "raw-body",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing stripe-signature header");
    });

    it("returns 400 when signature verification fails", async () => {
      setBillingDeps({
        processor: createMockProcessor({
          handleWebhook: vi.fn().mockRejectedValue(new Error("Webhook signature verification failed")) as IPaymentProcessor["handleWebhook"],
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=bad" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid webhook signature");
    });

    it("processes checkout.session.completed event and credits ledger", async () => {
      setBillingDeps({
        processor: createMockProcessor({
          handleWebhook: vi.fn().mockResolvedValue({
            handled: true,
            eventType: "checkout.session.completed",
            tenant: "t-new",
            creditedCents: 1000,
          }) as IPaymentProcessor["handleWebhook"],
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/webhook", {
        method: "POST",
        body: "raw-body",
        headers: { "stripe-signature": "t=123,v1=valid" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.handled).toBe(true);
      expect(body.tenant).toBe("t-new");
      expect(body.creditedCents).toBe(1000);
    });
  });
});
