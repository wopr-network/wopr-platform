import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayRoutes } from "../../src/gateway/routes.js";
import type { GatewayAuthEnv } from "../../src/gateway/service-key-auth.js";
import type { FetchFn, GatewayConfig, GatewayTenant } from "../../src/gateway/types.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const VALID_KEY = "wopr_sk_test_abc123";
const TENANT: GatewayTenant = {
  id: "tenant-1",
  spendLimits: { maxSpendPerHour: 100, maxSpendPerMonth: 1000 },
};

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
function createStubFetch(overrides: Partial<{
  status: number;
  body: string;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}> = {}): FetchFn {
  return async () => {
    return new Response(overrides.body ?? "{}", {
      status: overrides.status ?? 200,
      headers: overrides.headers ?? { "Content-Type": "application/json" },
    });
  };
}

function makeGatewayApp(opts: {
  fetchFn?: FetchFn;
  budgetAllowed?: boolean;
} = {}): Hono<GatewayAuthEnv> {
  const config: GatewayConfig = {
    meter: createStubMeter() as unknown as GatewayConfig["meter"],
    budgetChecker: createStubBudgetChecker(opts.budgetAllowed ?? true) as unknown as GatewayConfig["budgetChecker"],
    providers: {
      openrouter: { apiKey: "or-key", baseUrl: "https://test-openrouter.local" },
      deepgram: { apiKey: "dg-key", baseUrl: "https://test-deepgram.local" },
      elevenlabs: { apiKey: "el-key", baseUrl: "https://test-elevenlabs.local" },
      replicate: { apiToken: "rep-token", baseUrl: "https://test-replicate.local" },
      twilio: { accountSid: "AC123", authToken: "auth-token" },
    },
    defaultMargin: 1.3,
    fetchFn: opts.fetchFn ?? createStubFetch(),
    resolveServiceKey: resolver,
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
        "/v1/messages/sms",
        "/v1/messages/sms/inbound",
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

      expect(res.status).toBe(429);
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
      expect((meterEvents[0].cost as number)).toBeGreaterThan(0);
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
    it("initiates outbound call and meters connection", async () => {
      const app = makeGatewayApp();
      const res = await app.request("/v1/phone/outbound", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15551234567", from: "+15559876543" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("initiated");

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("phone-outbound");
    });
  });

  // -----------------------------------------------------------------------
  // Phone Inbound
  // -----------------------------------------------------------------------

  describe("POST /v1/phone/inbound", () => {
    it("meters per-minute events for inbound calls", async () => {
      const app = makeGatewayApp();
      const res = await app.request("/v1/phone/inbound", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ call_sid: "CA123", duration_minutes: 5, status: "completed" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { duration_minutes: number };
      expect(body.duration_minutes).toBe(5);

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("phone-inbound");
      // 5 minutes * $0.013/min = $0.065
      expect((meterEvents[0].cost as number)).toBeCloseTo(0.065, 3);
    });
  });

  // -----------------------------------------------------------------------
  // SMS Outbound
  // -----------------------------------------------------------------------

  describe("POST /v1/messages/sms", () => {
    it("sends SMS and meters per message", async () => {
      const app = makeGatewayApp();
      const res = await app.request("/v1/messages/sms", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "+15551234567", from: "+15559876543", body: "Hello!" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; capability: string };
      expect(body.status).toBe("sent");
      expect(body.capability).toBe("sms-outbound");

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("sms-outbound");
    });

    it("detects MMS when media_url is present", async () => {
      const app = makeGatewayApp();
      const res = await app.request("/v1/messages/sms", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          to: "+15551234567",
          from: "+15559876543",
          body: "Check this out",
          media_url: ["https://example.com/image.jpg"],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { capability: string };
      expect(body.capability).toBe("mms-outbound");

      expect(meterEvents[0].capability).toBe("mms-outbound");
    });
  });

  // -----------------------------------------------------------------------
  // SMS Inbound
  // -----------------------------------------------------------------------

  describe("POST /v1/messages/sms/inbound", () => {
    it("meters inbound SMS", async () => {
      const app = makeGatewayApp();
      const res = await app.request("/v1/messages/sms/inbound", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ from: "+15551234567", to: "+15559876543", body: "Hi there" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { capability: string };
      expect(body.capability).toBe("sms-inbound");

      expect(meterEvents.length).toBe(1);
      expect(meterEvents[0].capability).toBe("sms-inbound");
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
});
