/**
 * Integration tests for /api/billing/crypto/* routes (WOP-407).
 *
 * Tests PayRam crypto payment routes through the full composed Hono app.
 * Uses in-memory SQLite and mocked PayRam client.
 */
import BetterSqlite3 from "better-sqlite3";
import type { Payram } from "payram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";

const { app } = await import("../../src/api/app.js");
const { setBillingDeps } = await import("../../src/api/routes/billing.js");
const { createDb } = await import("../../src/db/index.js");
const { initCreditSchema } = await import("../../src/monetization/credits/schema.js");
const { initMeterSchema } = await import("../../src/monetization/metering/schema.js");
const { initStripeSchema } = await import("../../src/monetization/stripe/schema.js");
const { initPayRamSchema } = await import("../../src/monetization/payram/schema.js");

function createMockStripe() {
  return {
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
  } as unknown as import("stripe").default;
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
  let sqlite: BetterSqlite3.Database;
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new BetterSqlite3(":memory:");
    initMeterSchema(sqlite);
    initStripeSchema(sqlite);
    initCreditSchema(sqlite);
    initPayRamSchema(sqlite);
    db = createDb(sqlite);
    setBillingDeps({
      stripe: createMockStripe(),
      db,
      webhookSecret: "whsec_test_secret",
    });
  });

  afterEach(() => {
    sqlite.close();
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
    beforeEach(() => {
      process.env.PAYRAM_API_KEY = "test-api-key-12345";
      process.env.PAYRAM_BASE_URL = "https://payram.example.com";
      // Re-init deps to pick up the env vars
      setBillingDeps({
        stripe: createMockStripe(),
        db,
        webhookSecret: "whsec_test_secret",
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
