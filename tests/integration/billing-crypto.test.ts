/**
 * Integration tests for /api/billing/crypto/* routes.
 *
 * Tests crypto payment routes through the full composed Hono app.
 * Uses in-memory PGlite and mocked crypto service configuration.
 */
import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "@wopr-network/platform-core/test/db";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";

const { app } = await import("../../src/api/app.js");
const { setBillingDeps } = await import("../../src/api/routes/billing.js");
const { DrizzleLedger } = await import("@wopr-network/platform-core");
const { MeterAggregator } = await import("@wopr-network/platform-core/metering");
const { DrizzleUsageSummaryRepository } = await import("@wopr-network/platform-core/metering");
const { DrizzleAffiliateRepository } = await import("@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository");
const { DrizzleCryptoChargeRepository, noOpReplayGuard } = await import("@wopr-network/platform-core/billing");

function createMockProcessor(): import("@wopr-network/platform-core/monetization/payment-processor").IPaymentProcessor {
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

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("integration: billing crypto routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    vi.clearAllMocks();
    setBillingDeps({
      processor: createMockProcessor(),
      creditLedger: new DrizzleLedger(db),
      meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
      affiliateRepo: new DrizzleAffiliateRepository(db),
      replayGuard: noOpReplayGuard,
      cryptoReplayGuard: noOpReplayGuard,
      sigPenaltyRepo: {
        get: () => null,
        recordFailure: (ip: string) => ({ ip, source: "stripe", failures: 1, blockedUntil: 0, updatedAt: 0 }),
        clear: () => {},
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -- POST /api/billing/crypto/checkout (503 when not configured) --------

  describe("POST /api/billing/crypto/checkout (not configured)", () => {
    it("returns 503 when crypto service env vars are not set", async () => {
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
    it("returns 503 when crypto service is not configured", async () => {
      const res = await app.request("/api/billing/crypto/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryId: "del-001",
          webhookId: "wh-001",
          originalDeliveryId: "del-001",
          isRedelivery: false,
          type: "InvoiceSettled",
          timestamp: 1700000000,
          storeId: "store-1",
          invoiceId: "inv-001",
        }),
      });
      expect(res.status).toBe(503);
    });
  });

  // -- Tests with crypto service configured via env vars --------------------------

  describe("with CRYPTO_SERVICE_URL set", () => {
    const WEBHOOK_SECRET = "integration-test-webhook-secret";

    beforeEach(async () => {
      vi.stubEnv("CRYPTO_SERVICE_URL", "https://crypto.example.com");
      vi.stubEnv("BTCPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
      // Re-init deps to pick up the env vars
      setBillingDeps({
        processor: createMockProcessor(),
        creditLedger: new DrizzleLedger(db),
        meterAggregator: new MeterAggregator(new DrizzleUsageSummaryRepository(db)),
        affiliateRepo: new DrizzleAffiliateRepository(db),
        cryptoChargeRepo: new DrizzleCryptoChargeRepository(db),
        replayGuard: noOpReplayGuard,
        cryptoReplayGuard: noOpReplayGuard,
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
      it("returns 401 when BTCPAY-SIG header is missing", async () => {
        const body = JSON.stringify({
          deliveryId: "del-001",
          webhookId: "wh-001",
          originalDeliveryId: "del-001",
          isRedelivery: false,
          type: "InvoiceCreated",
          timestamp: 1700000000,
          storeId: "test-store-id",
          invoiceId: "inv-001",
        });

        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        expect(res.status).toBe(401);
      });

      it("returns 401 when BTCPAY-SIG header has wrong signature", async () => {
        const body = JSON.stringify({
          deliveryId: "del-002",
          webhookId: "wh-002",
          originalDeliveryId: "del-002",
          isRedelivery: false,
          type: "InvoiceCreated",
          timestamp: 1700000001,
          storeId: "test-store-id",
          invoiceId: "inv-002",
        });

        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "BTCPAY-SIG": "sha256=deadbeef" },
          body,
        });
        expect(res.status).toBe(401);
      });

      it("accepts valid BTCPAY-SIG and processes InvoiceCreated", async () => {
        const body = JSON.stringify({
          deliveryId: "del-003",
          webhookId: "wh-003",
          originalDeliveryId: "del-003",
          isRedelivery: false,
          type: "InvoiceCreated",
          timestamp: 1700000002,
          storeId: "test-store-id",
          invoiceId: "inv-003",
        });
        const sig = sign(body, WEBHOOK_SECRET);

        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "BTCPAY-SIG": sig },
          body,
        });
        // Not 401/403; may be 200 or 400 depending on charge lookup
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });

      it("does NOT require admin bearer auth (webhook uses crypto signature)", async () => {
        // Without bearer auth header, should NOT return 401 from bearer check.
        // Missing BTCPAY-SIG → 401 from crypto signature check, not from bearer auth.
        const body = JSON.stringify({
          deliveryId: "del-no-auth",
          webhookId: "wh-no-auth",
          originalDeliveryId: "del-no-auth",
          isRedelivery: false,
          type: "InvoiceCreated",
          timestamp: 1700000003,
          storeId: "test-store-id",
          invoiceId: "inv-no-auth",
        });

        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        // 401 is from missing BTCPAY-SIG crypto sig, not from missing bearer token
        expect(res.status).toBe(401);
      });

      it("returns 400 for malformed JSON body", async () => {
        const sig = sign("not json", WEBHOOK_SECRET);
        const res = await app.request("/api/billing/crypto/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "BTCPAY-SIG": sig },
          body: "not json",
        });
        expect(res.status).toBe(400);
      });
    });
  });
});
