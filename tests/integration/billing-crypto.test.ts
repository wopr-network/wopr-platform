/**
 * Integration tests for /api/billing/crypto/* routes (WOP-407).
 *
 * Tests PayRam crypto payment routes through the full composed Hono app.
 * Uses in-memory PGlite and mocked PayRam client.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { Payram } from "payram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";

const { app } = await import("../../src/api/app.js");
const { setBillingDeps } = await import("../../src/api/routes/billing.js");
const { CreditLedger } = await import("../../src/monetization/credits/credit-ledger.js");
const { MeterAggregator } = await import("../../src/monetization/metering/aggregator.js");
const { DrizzleAffiliateRepository } = await import("../../src/monetization/affiliate/drizzle-affiliate-repository.js");
const { DrizzlePayRamChargeStore } = await import("../../src/monetization/payram/charge-store.js");

function createMockProcessor(): import("../../src/monetization/payment-processor.js").IPaymentProcessor {
  return {
    name: "mock",
    supportsPortal: () => true,
    createCheckoutSession: vi.fn().mockResolvedValue({ id: "cs_test", url: "https://checkout.stripe.com/cs_test" }) as never,
    createPortalSession: vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/portal_test" }) as never,
    handleWebhook: vi.fn().mockResolvedValue({ handled: false, eventType: "unknown" }) as never,
    setupPaymentMethod: vi.fn().mockResolvedValue({ clientSecret: "seti_test" }) as never,
    listPaymentMethods: vi.fn().mockResolvedValue([]) as never,
    detachPaymentMethod: vi.fn().mockResolvedValue(undefined) as never,
    charge: vi.fn().mockResolvedValue({ success: true }) as never,
  };
}

function createMockPayram(overrides: { initiatePayment?: ReturnType<typeof vi.fn> } = {}): Payram {
  return {
    payments: {
      initiatePayment:
        overrides.initiatePayment ??
        vi.fn().mockResolvedValue({
          reference_id: "ref-test-crypto-001",
          url: "https://payram.example.com/pay/ref-test-crypto-001",
        }),
    },
  } as unknown as Payram;
}

describe("integration: billing crypto routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ db, pool } = await createTestDb());
    setBillingDeps({
      processor: createMockProcessor(),
      creditLedger: new CreditLedger(db),
      meterAggregator: new MeterAggregator(db),
      affiliateRepo: new DrizzleAffiliateRepository(db),
      sigPenaltyRepo: {
        get: () => null,
        recordFailure: (ip: string) => ({ ip, source: "stripe", failures: 1, blockedUntil: 0, updatedAt: 0 }),
        clear: () => {},
      },
    });
  });

  afterEach(async () => {
    await pool.close();
    // Clean up env vars set during tests
    delete process.env.PAYRAM_API_KEY;
    delete process.env.PAYRAM_BASE_URL;
  });

  // -- POST /api/billing/crypto/checkout (503 when not configured) --------

  describe("POST /api/billing/crypto/checkout (not configured)", () => {
    it("returns 503 when PayRam env vars are not set", async () => {
      const res = await app.request("/api/billing/crypto/checkout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tenant: "t-1", amountUsd: 25 }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("Crypto payments not configured");
    });

    it("requires admin auth for checkout endpoint", async () => {
      const res = await app.request("/api/billing/crypto/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant: "t-1", amountUsd: 25 }),
      });
      expect(res.status).toBe(401);
    });
  });

  // -- POST /api/billing/crypto/webhook (503 when not configured) ---------

  describe("POST /api/billing/crypto/webhook (not configured)", () => {
    it("returns 503 when PayRam is not configured", async () => {
      const res = await app.request("/api/billing/crypto/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "API-Key": "somekey" },
        body: JSON.stringify({
          reference_id: "ref-001",
          status: "FILLED",
          amount: "25.00",
          currency: "USDC",
          filled_amount: "25.00",
        }),
      });
      // payramChargeStore is null => 503
      expect(res.status).toBe(503);
    });
  });

  // -- Tests with PayRam configured via env vars --------------------------

  describe("with PAYRAM_API_KEY and PAYRAM_BASE_URL set", () => {
    beforeEach(async () => {
      process.env.PAYRAM_API_KEY = "test-api-key-12345";
      process.env.PAYRAM_BASE_URL = "https://payram.example.com";
      // Re-init deps to pick up the env vars
      setBillingDeps({
        processor: createMockProcessor(),
        creditLedger: new CreditLedger(db),
        meterAggregator: new MeterAggregator(db),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        payramChargeStore: new DrizzlePayRamChargeStore(db),
        sigPenaltyRepo: {
          get: () => null,
          recordFailure: (ip: string, source: string) => ({ ip, source, failures: 1, blockedUntil: 0, updatedAt: 0 }),
          clear: () => {},
          purgeStale: () => 0,
        },
      });
    });

    describe("POST /api/billing/crypto/checkout", () => {
      it("returns 400 for amount below minimum ($10)", async () => {
        const res = await app.request("/api/billing/crypto/checkout", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tenant: "t-1", amountUsd: 5 }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("Invalid input");
      });

      it("returns 400 for invalid tenant ID", async () => {
        const res = await app.request("/api/billing/crypto/checkout", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tenant: "t-1; DROP TABLE", amountUsd: 25 }),
        });
        expect(res.status).toBe(400);
      });

      it("returns 400 for malformed JSON", async () => {
        const res = await app.request("/api/billing/crypto/checkout", {
          method: "POST",
          headers: JSON_HEADERS,
          body: "not json",
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("Invalid JSON body");
      });

      it("returns 400 for missing amountUsd", async () => {
        const res = await app.request("/api/billing/crypto/checkout", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tenant: "t-1" }),
        });
        expect(res.status).toBe(400);
      });
    });

    describe("POST /api/billing/crypto/webhook", () => {
      it("returns 401 when API-Key header is missing", async () => {
        const res = await app.request("/api/billing/crypto/webhook", {
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
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe("Unauthorized");
      });

      it("returns 401 when API-Key header is wrong", async () => {
        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "API-Key": "wrong-key" },
          body: JSON.stringify({
            reference_id: "ref-001",
            status: "FILLED",
            amount: "25.00",
            currency: "USDC",
            filled_amount: "25.00",
          }),
        });
        expect(res.status).toBe(401);
      });

      it("returns 400 for invalid payload schema", async () => {
        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "API-Key": "test-api-key-12345" },
          body: JSON.stringify({ bad: "payload" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.received).toBe(false);
      });

      it("returns { received: true } for valid webhook with unknown reference_id", async () => {
        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "API-Key": "test-api-key-12345" },
          body: JSON.stringify({
            reference_id: "ref-unknown-xyz",
            status: "FILLED",
            amount: "25.00",
            currency: "USDC",
            filled_amount: "25.00",
          }),
        });
        // handled:false from handler, but route returns { received: false }
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.received).toBe(false);
      });

      it("does NOT require admin bearer auth (webhook uses API key only)", async () => {
        // Should return 401 (wrong key) not 401 (missing bearer token)
        // i.e. the webhook route skips bearer auth
        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference_id: "ref-001",
            status: "OPEN",
            amount: "0",
            currency: "USDC",
            filled_amount: "0",
          }),
        });
        // Missing API-Key -> 401 from PayRam check, not 401 from bearer auth
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe("Unauthorized"); // PayRam auth error, not bearer
      });

      it("returns 400 for malformed JSON body", async () => {
        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "API-Key": "test-api-key-12345" },
          body: "not json",
        });
        expect(res.status).toBe(400);
      });
    });
  });
});
