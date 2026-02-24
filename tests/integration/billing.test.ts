/**
 * Integration tests for /api/billing/* routes (credit purchase model, WOP-406).
 *
 * Tests billing endpoints through the full composed Hono app.
 * Uses in-memory SQLite for the tenant store and mocked Stripe.
 */
import BetterSqlite3 from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";

const { app } = await import("../../src/api/app.js");
const { setBillingDeps } = await import("../../src/api/routes/billing.js");
const { DrizzleSigPenaltyRepository } = await import("../../src/api/drizzle-sig-penalty-repository.js");
const { createDb } = await import("../../src/db/index.js");
const { drizzle } = await import("drizzle-orm/better-sqlite3");
const { initCreditSchema } = await import("../../src/monetization/credits/schema.js");
const { initMeterSchema } = await import("../../src/monetization/metering/schema.js");
const { initStripeSchema } = await import("../../src/monetization/stripe/schema.js");
const { TenantCustomerStore } = await import("../../src/monetization/stripe/tenant-store.js");
import * as schema from "../../src/db/schema/index.js";

function createTestSigPenaltyRepo() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(`
    CREATE TABLE webhook_sig_penalties (
      ip TEXT NOT NULL,
      source TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ip, source)
    )
  `);
  return new DrizzleSigPenaltyRepository(drizzle(sqlite, { schema }));
}
const { initAffiliateSchema } = await import("../../src/monetization/affiliate/schema.js");
const { DrizzleAffiliateRepository } = await import("../../src/monetization/affiliate/drizzle-affiliate-repository.js");

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

describe("integration: billing routes", () => {
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof createDb>;
  let tenantStore: TenantCustomerStore;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new BetterSqlite3(":memory:");
    initMeterSchema(sqlite);
    initStripeSchema(sqlite);
    initCreditSchema(sqlite);
    initAffiliateSchema(sqlite);
    db = createDb(sqlite);
    tenantStore = new TenantCustomerStore(db);
    setBillingDeps({
      stripe: createMockStripe(),
      db,
      webhookSecret: "whsec_test_secret",
      sigPenaltyRepo: createTestSigPenaltyRepo(),
      affiliateRepo: new DrizzleAffiliateRepository(db),
    });
  });

  afterEach(() => {
    sqlite.close();
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

    it("returns 500 when Stripe API fails", async () => {
      const checkoutCreate = vi.fn().mockRejectedValue(new Error("Stripe is down"));
      setBillingDeps({
        stripe: createMockStripe({ checkoutCreate }),
        db,
        webhookSecret: "whsec_test",
        sigPenaltyRepo: createTestSigPenaltyRepo(),
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
      tenantStore.upsert({ tenant: "t-1", processorCustomerId: "cus_abc" });
      const portalCreate = vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/portal" });
      setBillingDeps({
        stripe: createMockStripe({ portalCreate }),
        db,
        webhookSecret: "whsec_test",
        sigPenaltyRepo: createTestSigPenaltyRepo(),
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

    it("returns 500 when tenant has no Stripe customer", async () => {
      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          tenant: "unknown-tenant",
          returnUrl: "https://example.com/billing",
        }),
      });
      expect(res.status).toBe(500);
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
      const constructEvent = vi.fn().mockImplementation(() => {
        throw new Error("Webhook signature verification failed");
      });
      setBillingDeps({
        stripe: createMockStripe({ constructEvent }),
        db,
        webhookSecret: "whsec_test",
        sigPenaltyRepo: createTestSigPenaltyRepo(),
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
      const event: Stripe.Event = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_integ",
            client_reference_id: "t-new",
            customer: "cus_new",
            amount_total: 1000,
            metadata: {},
          },
        },
      } as unknown as Stripe.Event;

      const constructEvent = vi.fn().mockReturnValue(event);
      setBillingDeps({
        stripe: createMockStripe({ constructEvent }),
        db,
        webhookSecret: "whsec_test",
        sigPenaltyRepo: createTestSigPenaltyRepo(),
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
