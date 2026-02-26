/**
 * Integration tests for /api/billing/* routes (credit purchase model, WOP-406).
 *
 * Tests billing endpoints through the full composed Hono app.
 * Uses in-memory PGlite for the tenant store and mocked IPaymentProcessor.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";

const { app } = await import("../../src/api/app.js");
const { setBillingDeps } = await import("../../src/api/routes/billing.js");
const { DrizzleSigPenaltyRepository } = await import("../../src/api/drizzle-sig-penalty-repository.js");
const { CreditLedger } = await import("../../src/monetization/credits/credit-ledger.js");
const { MeterAggregator } = await import("../../src/monetization/metering/aggregator.js");
const { TenantCustomerStore } = await import("../../src/monetization/stripe/tenant-store.js");
import type { IPaymentProcessor } from "../../src/monetization/payment-processor.js";
const { DrizzleAffiliateRepository } = await import("../../src/monetization/affiliate/drizzle-affiliate-repository.js");

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
      url: "https://checkout.stripe.com/cs_test_123",
    }) as IPaymentProcessor["createCheckoutSession"],
    createPortalSession: vi.fn().mockResolvedValue({
      url: "https://billing.stripe.com/session_xyz",
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
  let tenantStore: InstanceType<typeof TenantCustomerStore>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ db, pool } = await createTestDb());
    tenantStore = new TenantCustomerStore(db);
    setBillingDeps({
      processor: createMockProcessor(),
      creditLedger: new CreditLedger(db),
      meterAggregator: new MeterAggregator(db),
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
          successUrl: "https://example.com/s",
          cancelUrl: "https://example.com/c",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects /api/billing/portal without token", async () => {
      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant: "t-1", returnUrl: "https://example.com" }),
      });
      expect(res.status).toBe(401);
    });

    it("/api/billing/webhook does NOT require bearer auth", async () => {
      // Webhook uses Stripe signature verification, not bearer auth.
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
          successUrl: "https://example.com/success",
          cancelUrl: "https://example.com/cancel",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://checkout.stripe.com/cs_test_123");
      expect(body.sessionId).toBe("cs_test_123");
    });

    it("returns 400 for missing tenant", async () => {
      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          priceId: "price_abc",
          successUrl: "https://example.com/s",
          cancelUrl: "https://example.com/c",
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
          successUrl: "https://example.com/s",
          cancelUrl: "https://example.com/c",
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
          cancelUrl: "https://example.com/c",
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
          createCheckoutSession: vi.fn().mockRejectedValue(new Error("Stripe is down")) as IPaymentProcessor["createCheckoutSession"],
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/credits/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "t-1",
          priceId: "price_abc",
          successUrl: "https://example.com/s",
          cancelUrl: "https://example.com/c",
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
          createPortalSession: vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/portal" }) as IPaymentProcessor["createPortalSession"],
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "t-1",
          returnUrl: "https://example.com/billing",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://billing.stripe.com/portal");
    });

    it("returns 501 when processor does not support portal", async () => {
      setBillingDeps({
        processor: createMockProcessor({
          supportsPortal: () => false,
        }),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        sigPenaltyRepo: await createTestSigPenaltyRepo(),
        affiliateRepo: new DrizzleAffiliateRepository(db),
      });

      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "unknown-tenant",
          returnUrl: "https://example.com/billing",
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
        meterAggregator: new MeterAggregator(db),
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
        meterAggregator: new MeterAggregator(db),
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
