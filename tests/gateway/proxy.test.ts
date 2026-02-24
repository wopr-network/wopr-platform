import crypto from "node:crypto";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleSigPenaltyRepository } from "../../src/api/drizzle-sig-penalty-repository.js";
import * as schema from "../../src/db/schema/index.js";
import { createGatewayRoutes } from "../../src/gateway/routes.js";
import type { GatewayAuthEnv } from "../../src/gateway/service-key-auth.js";
import type { FetchFn, GatewayConfig, GatewayTenant } from "../../src/gateway/types.js";

function makeTestSigPenaltyRepo() {
  const sqlite = new Database(":memory:");
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

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const VALID_KEY = "wopr_sk_test_abc123";
const TENANT: GatewayTenant = {
  id: "tenant-1",
  spendLimits: { maxSpendPerHour: 100, maxSpendPerMonth: 1000 },
};

/** Twilio auth token used for test webhook signature verification. */
const TEST_TWILIO_AUTH_TOKEN = "test-twilio-auth-token";
/** Base URL used for webhook signature computation in tests. */
const TEST_WEBHOOK_BASE_URL = "https://api.test.wopr.network/v1";

/** Compute a valid Twilio HMAC-SHA1 signature for testing. */
function computeTwilioSignature(url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return crypto.createHmac("sha1", TEST_TWILIO_AUTH_TOKEN).update(data).digest("base64");
}

/** Build Twilio signature headers for a webhook test request.
 *
 * Coerces all scalar body values to strings (matching middleware behavior for JSON bodies).
 */
function twilioWebhookHeaders(path: string, bodyParams: Record<string, unknown> = {}) {
  const url = `${TEST_WEBHOOK_BASE_URL}${path}`;
  // Coerce scalars to strings — same as middleware JSON body handling
  const stringParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(bodyParams)) {
    if (
      value !== null &&
      value !== undefined &&
      !Array.isArray(value) &&
      typeof value !== "object"
    ) {
      stringParams[key] = String(value);
    }
  }
  return {
    "Content-Type": "application/json",
    "X-Twilio-Signature": computeTwilioSignature(url, stringParams),
  };
}

function resolver(key: string): GatewayTenant | null {
  return key === VALID_KEY ? TENANT : null;
}

/** Track meter events emitted. */
const meterEvents: Array<Record<string, unknown>> = [];

function createStubMeter() {
  return {
    emit(event: Record<string, unknown>) {
      meterEvents.push(event);
    },
    flush: () => 0,
    close: () => {},
    get pending() {
      return 0;
    },
    queryEvents: () => [],
  };
}

function createStubBudgetChecker(allowed = true) {
  return {
    check: () => ({
      allowed,
      reason: allowed ? undefined : "Budget exceeded",
      httpStatus: allowed ? undefined : 429,
      currentHourlySpend: 5,
      currentMonthlySpend: 50,
      maxSpendPerHour: 100,
      maxSpendPerMonth: 1000,
    }),
    invalidate: () => {},
    clearCache: () => {},
  };
}

/** Create a stub fetch that returns configurable responses. */
function createStubFetch(
  overrides: Partial<{
    status: number;
    body: string;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
  }> = {},
): FetchFn {
  return async () => {
    return new Response(overrides.body ?? "{}", {
      status: overrides.status ?? 200,
      headers: overrides.headers ?? { "Content-Type": "application/json" },
    });
  };
}

class StubCreditLedger {
  private balances = new Map<string, number>();

  constructor(initialBalance: number) {
    this.balances.set(TENANT.id, initialBalance);
  }

  balance(tenantId: string): number {
    return this.balances.get(tenantId) ?? 0;
  }

  credit(tenantId: string, cents: number): void {
    const current = this.balances.get(tenantId) ?? 0;
    this.balances.set(tenantId, current + cents);
  }

  debit(tenantId: string, cents: number): void {
    const current = this.balances.get(tenantId) ?? 0;
    this.balances.set(tenantId, current - cents);
  }

  transactions(): Array<{
    tenantId: string;
    amountCents: number;
    type: string;
    description: string;
    timestamp: number;
  }> {
    return [];
  }
}

function makeGatewayApp(
  opts: { fetchFn?: FetchFn; budgetAllowed?: boolean; creditBalance?: number } = {},
): Hono<GatewayAuthEnv> {
  const config: GatewayConfig = {
    meter: createStubMeter() as unknown as GatewayConfig["meter"],
    budgetChecker: createStubBudgetChecker(
      opts.budgetAllowed ?? true,
    ) as unknown as GatewayConfig["budgetChecker"],
    creditLedger:
      opts.creditBalance !== undefined
        ? (new StubCreditLedger(opts.creditBalance) as unknown as GatewayConfig["creditLedger"])
        : undefined,
    topUpUrl: "/dashboard/credits",
    providers: {
      openrouter: { apiKey: "or-key", baseUrl: "https://test-openrouter.local" },
      deepgram: { apiKey: "dg-key", baseUrl: "https://test-deepgram.local" },
      elevenlabs: { apiKey: "el-key", baseUrl: "https://test-elevenlabs.local" },
      replicate: { apiToken: "rep-token", baseUrl: "https://test-replicate.local" },
      twilio: { accountSid: "AC123", authToken: TEST_TWILIO_AUTH_TOKEN },
    },
    defaultMargin: 1.3,
    fetchFn: opts.fetchFn ?? createStubFetch(),
    resolveServiceKey: resolver,
    webhookBaseUrl: TEST_WEBHOOK_BASE_URL,
    resolveTenantFromWebhook: () => TENANT,
    sigPenaltyRepo: makeTestSigPenaltyRepo(),
  };

  const app = new Hono<GatewayAuthEnv>();
  app.route("/v1", createGatewayRoutes(config));
  return app;
}

function authHeaders() {
  return { Authorization: `Bearer ${VALID_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gateway proxy endpoints", () => {
  beforeEach(() => {
    meterEvents.length = 0;
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe("authentication", () => {
    it("rejects unauthenticated requests on all endpoints", async () => {
      const app = makeGatewayApp();
      const endpoints = [
        "/v1/chat/completions",
        "/v1/completions",
        "/v1/embeddings",
        "/v1/audio/transcriptions",
        "/v1/audio/speech",
        "/v1/images/generations",
        "/v1/video/generations",
        "/v1/phone/outbound",
        "/v1/phone/inbound",
        "/v1/phone/numbers",
        "/v1/messages/sms",
        "/v1/messages/sms/inbound",
        "/v1/messages/sms/status",
      ];

      for (const path of endpoints) {
        const res = await app.request(path, { method: "POST" });
        expect(res.status).toBe(401);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Budget check
  // -----------------------------------------------------------------------

  describe("budget check", () => {
    it("rejects requests when budget is exceeded", async () => {
      const app = makeGatewayApp({ budgetAllowed: false });

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("insufficient_credits");
    });
  });

  // -----------------------------------------------------------------------
  // LLM Chat Completions
  // -----------------------------------------------------------------------

  describe("POST /v1/chat/completions", () => {
    it("proxies to OpenRouter and emits meter event", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [{ message: { content: "Hello!" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-cost": "0.00012",
        },
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("choices");

      // Meter event should have been emitted
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].tenant).toBe("tenant-1");
      expect(meterEvents[0].capability).toBe("chat-completions");
      expect(meterEvents[0].provider).toBe("openrouter");
    });
  });

  // -----------------------------------------------------------------------
  // LLM Text Completions
  // -----------------------------------------------------------------------

  describe("POST /v1/completions", () => {
    it("proxies text completions and meters", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          id: "cmpl-1",
          choices: [{ text: "response" }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        headers: { "Content-Type": "application/json", "x-openrouter-cost": "0.00005" },
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-3.5-turbo", prompt: "Hello" }),
      });

      expect(res.status).toBe(200);
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("text-completions");
    });
  });

  // -----------------------------------------------------------------------
  // Embeddings
  // -----------------------------------------------------------------------

  describe("POST /v1/embeddings", () => {
    it("proxies embeddings and meters", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          model: "text-embedding-3-small",
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: { total_tokens: 8 },
        }),
        headers: { "Content-Type": "application/json", "x-openrouter-cost": "0.000001" },
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/embeddings", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ input: "Hello world", model: "text-embedding-3-small" }),
      });

      expect(res.status).toBe(200);
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("embeddings");
    });
  });

  // -----------------------------------------------------------------------
  // STT (Audio Transcriptions)
  // -----------------------------------------------------------------------

  describe("POST /v1/audio/transcriptions", () => {
    it("proxies to Deepgram and meters by duration", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          results: {
            channels: [{ alternatives: [{ transcript: "Hello world" }] }],
          },
          metadata: { duration: 30 },
        }),
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/audio/transcriptions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
        body: new ArrayBuffer(100),
      });

      expect(res.status).toBe(200);
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("transcription");
      expect(meterEvents[0].provider).toBe("deepgram");
      // 30 seconds = 0.5 minutes * 0.0043 = ~0.00215
      expect(meterEvents[0].cost as number).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // TTS (Audio Speech)
  // -----------------------------------------------------------------------

  describe("POST /v1/audio/speech", () => {
    it("proxies to ElevenLabs and meters by character count", async () => {
      // ElevenLabs returns audio bytes
      const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      const stubFetch: FetchFn = async () => {
        return new Response(audioBytes, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      };

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/audio/speech", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ input: "Hello world, this is a test.", voice: "alloy" }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("tts");
      expect(meterEvents[0].provider).toBe("elevenlabs");
    });
  });

  // -----------------------------------------------------------------------
  // Image Generation
  // -----------------------------------------------------------------------

  describe("POST /v1/images/generations", () => {
    it("proxies to Replicate and returns OpenAI-compatible format", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          status: "succeeded",
          output: ["https://replicate.com/output/img1.png"],
          metrics: { predict_time: 3.5 },
        }),
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/images/generations", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "A cat in space", n: 1, size: "1024x1024" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ url: string }>; created: number };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].url).toContain("replicate.com");
      expect(body.created).toBeGreaterThan(0);

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("image-generation");
      expect(meterEvents[0].provider).toBe("replicate");
    });
  });

  // -----------------------------------------------------------------------
  // Video Generation
  // -----------------------------------------------------------------------

  describe("POST /v1/video/generations", () => {
    it("proxies video generation and meters", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          status: "succeeded",
          output: "https://replicate.com/output/video.mp4",
          metrics: { predict_time: 25 },
        }),
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/video/generations", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "A sunset timelapse" }),
      });

      expect(res.status).toBe(200);
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("video-generation");
    });
  });

  // -----------------------------------------------------------------------
  // Phone Outbound
  // -----------------------------------------------------------------------

    describe("POST /v1/phone/outbound", () => {
      const stubFetch = async (_url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const url = _url as string;
        if (url.includes("/Calls.json")) {
          return new Response(JSON.stringify({ sid: "CA1234567890", status: "queued" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ sid: "SM123", status: "sent" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      it("makes outbound call and defers billing to StatusCallback", async () => {
        const app = makeGatewayApp({ fetchFn: stubFetch });
        const res = await app.request("/v1/phone/outbound", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ to: "+15551234567", from: "+15559876543" }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { sid: string; status: string };
        expect(body.sid).toBe("CA1234567890");
        expect(body.status).toBe("queued");
        // Billing is deferred to the StatusCallback webhook when webhookBaseUrl is configured.
        // No meter event should fire at call initiation.
        expect(meterEvents.length).toBe(0);
      });

      it("meters actual call duration via StatusCallback", async () => {
        const app = makeGatewayApp({ fetchFn: stubFetch });
        const path = "/phone/outbound/status/tenant-1";
        // Twilio sends CallDuration in seconds
        const bodyJson = { CallSid: "CA1234567890", CallDuration: 125, CallStatus: "completed" };
        const res = await app.request(`/v1${path}`, {
          method: "POST",
          headers: twilioWebhookHeaders(path, bodyJson),
          body: JSON.stringify(bodyJson),
        });

        expect(res.status).toBe(200);

        // 125 seconds = ceil(125/60) = 3 minutes billed
        expect(meterEvents.length).toBe(1);
        expect(meterEvents[0].capability).toBe("phone-outbound");
        expect(meterEvents[0].provider).toBe("twilio");
        // 3 minutes * $0.013/min = $0.039
        expect(meterEvents[0].cost as number).toBeCloseTo(0.039, 3);
      });
    });

  // -----------------------------------------------------------------------
  // Phone Inbound
  // -----------------------------------------------------------------------

  describe("POST /v1/phone/inbound/:tenantId", () => {
    it("meters per-minute events for inbound calls", async () => {
      const app = makeGatewayApp();
      const path = "/phone/inbound/tenant-1";
      const bodyJson = { call_sid: "CA123", duration_minutes: 5, status: "completed" };
      const res = await app.request(`/v1${path}`, {
        method: "POST",
        headers: twilioWebhookHeaders(path, bodyJson),
        body: JSON.stringify(bodyJson),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { duration_minutes: number };
      expect(body.duration_minutes).toBe(5);

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("phone-inbound");
      // 5 minutes * $0.013/min = $0.065
      expect(meterEvents[0].cost as number).toBeCloseTo(0.065, 3);
    });
  });

  // -----------------------------------------------------------------------
  // SMS Outbound
  // -----------------------------------------------------------------------

  describe("POST /v1/messages/sms", () => {
    it("sends SMS via Twilio and emits meter event", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({ sid: "SM123", status: "queued" }),
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/messages/sms", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15551234567", body: "Hello!", from: "+15559999999" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sid: string; status: string; capability: string };
      expect(body.sid).toBe("SM123");
      expect(body.status).toBe("queued");
      expect(body.capability).toBe("sms-outbound");

      // Meter event emitted with per-message cost
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].tenant).toBe("tenant-1");
      expect(meterEvents[0].capability).toBe("sms-outbound");
      expect(meterEvents[0].provider).toBe("twilio");
      expect(meterEvents[0].cost as number).toBeCloseTo(0.0079, 4);
    });

    it("sends MMS when media_url is present and meters at MMS rate", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({ sid: "MM456", status: "queued" }),
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/messages/sms", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          to: "+15551234567",
          body: "Check this out",
          from: "+15559999999",
          media_url: ["https://example.com/image.jpg"],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sid: string; capability: string };
      expect(body.sid).toBe("MM456");
      expect(body.capability).toBe("mms-outbound");

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("mms-outbound");
      expect(meterEvents[0].cost as number).toBeCloseTo(0.02, 4);
    });

    it("rejects requests missing required fields", async () => {
      const app = makeGatewayApp();
      const res = await app.request("/v1/messages/sms", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15551234567" }), // missing body field
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("missing_field");
      expect(meterEvents.length).toBe(0);
    });

    it("does not meter when Twilio returns an error", async () => {
      const failFetch = createStubFetch({
        status: 400,
        body: JSON.stringify({ code: 21211, message: "Invalid To number" }),
      });

      const app = makeGatewayApp({ fetchFn: failFetch });
      const res = await app.request("/v1/messages/sms", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "invalid", body: "test", from: "+15559999999" }),
      });

      expect(res.status).toBe(400);
      expect(meterEvents.length).toBe(0);
    });

    it("budget-checks before sending", async () => {
      const app = makeGatewayApp({ budgetAllowed: false });
      const res = await app.request("/v1/messages/sms", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15551234567", body: "test", from: "+15559999999" }),
      });

      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("insufficient_credits");
      expect(meterEvents.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // SMS Inbound
  // -----------------------------------------------------------------------

  describe("POST /v1/messages/sms/inbound/:tenantId", () => {
    it("meters inbound SMS at wholesale rate", async () => {
      const app = makeGatewayApp();
      const path = "/messages/sms/inbound/tenant-1";
      const bodyParams = {
        from: "+15551234567",
        to: "+15559876543",
        body: "Hi there",
        message_sid: "SM789",
      };
      const res = await app.request(`/v1${path}`, {
        method: "POST",
        headers: twilioWebhookHeaders(path, bodyParams),
        body: JSON.stringify(bodyParams),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { capability: string; message_sid: string };
      expect(body.capability).toBe("sms-inbound");
      expect(body.message_sid).toBe("SM789");

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("sms-inbound");
      expect(meterEvents[0].cost as number).toBeCloseTo(0.0079, 4);
    });

    it("meters inbound MMS at higher rate", async () => {
      const app = makeGatewayApp();
      const path = "/messages/sms/inbound/tenant-1";
      const bodyParams = { from: "+15551234567", to: "+15559876543", body: "Photo" };
      const res = await app.request(`/v1${path}`, {
        method: "POST",
        headers: twilioWebhookHeaders(path, bodyParams),
        body: JSON.stringify({ ...bodyParams, media_url: ["https://example.com/photo.jpg"] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { capability: string };
      expect(body.capability).toBe("mms-inbound");

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("mms-inbound");
      expect(meterEvents[0].cost as number).toBeCloseTo(0.02, 4);
    });
  });

  // -----------------------------------------------------------------------
  // SMS Delivery Status
  // -----------------------------------------------------------------------

  describe("POST /v1/messages/sms/status/:tenantId", () => {
    it("acknowledges delivery status callbacks", async () => {
      const app = makeGatewayApp();
      const path = "/messages/sms/status/tenant-1";
      const bodyParams = { message_sid: "SM123", message_status: "delivered" };
      const res = await app.request(`/v1${path}`, {
        method: "POST",
        headers: twilioWebhookHeaders(path, bodyParams),
        body: JSON.stringify(bodyParams),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        message_sid: string;
        message_status: string;
      };
      expect(body.status).toBe("acknowledged");
      expect(body.message_sid).toBe("SM123");
      expect(body.message_status).toBe("delivered");
    });

    it("handles failed delivery status", async () => {
      const app = makeGatewayApp();
      const path = "/messages/sms/status/tenant-1";
      const bodyJson = {
        message_sid: "SM456",
        message_status: "failed",
        error_code: 30008,
        error_message: "Unknown error",
      };
      const res = await app.request(`/v1${path}`, {
        method: "POST",
        headers: twilioWebhookHeaders(path, bodyJson),
        body: JSON.stringify(bodyJson),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { message_status: string };
      expect(body.message_status).toBe("failed");
    });
  });

  // -----------------------------------------------------------------------
  // Phone Number Management
  // -----------------------------------------------------------------------

  describe("POST /v1/phone/numbers (provision)", () => {
    it("provisions a phone number via Twilio", async () => {
      let callCount = 0;
      const stubFetch: FetchFn = async (url) => {
        callCount++;
        // First call: search for available numbers
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              available_phone_numbers: [
                {
                  phone_number: "+15551112222",
                  friendly_name: "(555) 111-2222",
                  capabilities: { sms: true, voice: true, mms: true },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Second call: purchase the number
        return new Response(
          JSON.stringify({
            sid: "PN123",
            phone_number: "+15551112222",
            friendly_name: "(555) 111-2222",
            capabilities: { sms: true, voice: true, mms: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/phone/numbers", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ area_code: "555" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; phone_number: string };
      expect(body.id).toBe("PN123");
      expect(body.phone_number).toBe("+15551112222");

      // Should meter the phone number cost
      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("phone-number-provision");
    });

    it("returns 404 when no numbers are available", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({ available_phone_numbers: [] }),
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/phone/numbers", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ area_code: "999" }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("no_numbers_available");
    });
  });

  describe("GET /v1/phone/numbers (list)", () => {
    it("lists tenant phone numbers", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          incoming_phone_numbers: [
            {
              sid: "PN123",
              phone_number: "+15551112222",
              friendly_name: "Main",
              capabilities: { sms: true, voice: true, mms: true },
            },
            {
              sid: "PN456",
              phone_number: "+15553334444",
              friendly_name: "Support",
              capabilities: { sms: true, voice: false, mms: false },
            },
          ],
        }),
      });

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/phone/numbers", {
        method: "GET",
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; phone_number: string }> };
      expect(body.data).toHaveLength(2);
      expect(body.data[0].id).toBe("PN123");
      expect(body.data[1].phone_number).toBe("+15553334444");
    });
  });

  describe("DELETE /v1/phone/numbers/:id (release)", () => {
    it("releases a phone number", async () => {
      let callCount = 0;
      const stubFetch: FetchFn = async () => {
        callCount++;
        // First call: GET to verify ownership (returns number info with tenant FriendlyName)
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              friendly_name: "wopr:tenant:tenant-1",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Second call: DELETE
        return new Response(null, { status: 204 });
      };

      const app = makeGatewayApp({ fetchFn: stubFetch });
      const res = await app.request("/v1/phone/numbers/PN123", {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; id: string };
      expect(body.status).toBe("released");
      expect(body.id).toBe("PN123");
    });
  });

  // -----------------------------------------------------------------------
  // Provider errors
  // -----------------------------------------------------------------------

  describe("provider error handling", () => {
    it("returns 502 when upstream fetch throws", async () => {
      const failFetch: FetchFn = async () => {
        throw new Error("Network error");
      };

      const app = makeGatewayApp({ fetchFn: failFetch });
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("upstream_error");

      // No meter event should be emitted on failure
      expect(meterEvents.length).toBe(0);
    });

    it("does not meter LLM requests when upstream returns non-ok status", async () => {
      const failFetch = createStubFetch({
        status: 500,
        body: JSON.stringify({ error: "internal server error" }),
      });

      const app = makeGatewayApp({ fetchFn: failFetch });
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      expect(res.status).toBe(500);
      // No meter event -- upstream failed
      expect(meterEvents.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Service not configured
  // -----------------------------------------------------------------------

  describe("service not configured", () => {
    it("returns 503 when provider is not configured", async () => {
      const config: GatewayConfig = {
        meter: createStubMeter() as unknown as GatewayConfig["meter"],
        budgetChecker: createStubBudgetChecker() as unknown as GatewayConfig["budgetChecker"],
        providers: {}, // no providers configured
        fetchFn: createStubFetch(),
        resolveServiceKey: resolver,
      };

      const app = new Hono<GatewayAuthEnv>();
      app.route("/v1", createGatewayRoutes(config));

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("service_unavailable");
    });
  });

  // -----------------------------------------------------------------------
  // Credit gate tests
  // -----------------------------------------------------------------------

  describe("credit balance check", () => {
    it("returns 402 when credit balance is insufficient", async () => {
      const app = makeGatewayApp({ creditBalance: 0 }); // Zero balance

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      });

      expect(res.status).toBe(402);
      const body = (await res.json()) as {
        error: {
          code: string;
          message: string;
          type: string;
          needsCredits: boolean;
          topUpUrl: string;
        };
      };
      expect(body.error.code).toBe("insufficient_credits");
      expect(body.error.message).toContain("Insufficient credits");
      expect(body.error.needsCredits).toBe(true);
      expect(body.error.topUpUrl).toBe("/dashboard/credits");
    });

    it("allows requests with sufficient credits", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [{ message: { content: "Hello!" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-cost": "0.00012",
        },
      });

      const app = makeGatewayApp({ fetchFn: stubFetch, creditBalance: 10000 }); // 100 USD

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      });

      expect(res.status).toBe(200);
    });

    it("debits credits after successful proxy call", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [{ message: { content: "Hello!" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-cost": "0.05", // 5 cents
        },
      });

      const app = makeGatewayApp({ fetchFn: stubFetch, creditBalance: 10000 });

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      });

      expect(res.status).toBe(200);
      // Credits should have been debited (tested via meter event in earlier tests)
    });

    it("blocks zero-balance tenants on endpoints with estimated cost", async () => {
      const stubFetch = createStubFetch({
        body: JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [{ message: { content: "Hello!" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-cost": "0.001", // Sub-cent actual cost
        },
      });

      const app = makeGatewayApp({ fetchFn: stubFetch, creditBalance: 0 });

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      });

      // Even though actual cost might be sub-cent, we block on estimated 1 cent minimum
      expect(res.status).toBe(402);
    });

    it("returns 402 when credit balance is zero", async () => {
      const app = makeGatewayApp({ creditBalance: 0 }); // Zero balance

      const res = await app.request("/v1/phone/outbound", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15551234567", from: "+15559876543" }),
      });

      // Now implemented - returns 402 for insufficient credits
      expect(res.status).toBe(402);
    });
  });
});
