import { Credit } from "@wopr-network/platform-core/credits";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ProxyDeps } from "./proxy.js";
import {
  audioSpeech,
  audioTranscriptions,
  chatCompletions,
  embeddings,
  imageGenerations,
  textCompletions,
} from "./proxy.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";

function makeDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    budgetChecker: { check: vi.fn(() => ({ allowed: true })) } as never,
    meter: { emit: vi.fn() } as never,
    creditLedger: { balance: vi.fn(() => Credit.fromCents(1000)), debit: vi.fn() } as never,
    providers: {
      openrouter: { apiKey: "test-key", baseUrl: "https://mock.test" },
      deepgram: { apiKey: "dg-key", baseUrl: "https://mock-dg.test" },
      elevenlabs: { apiKey: "el-key", baseUrl: "https://mock-el.test" },
      replicate: { apiToken: "rep-token", baseUrl: "https://mock-rep.test" },
    },
    fetchFn: vi.fn() as ProxyDeps["fetchFn"],
    defaultMargin: 1.3,
    topUpUrl: "https://example.com/topup",
    metrics: { recordGatewayRequest: vi.fn(), recordGatewayError: vi.fn() } as never,
    ...overrides,
  };
}

function makeApp(
  deps: ProxyDeps,
  path: string,
  handler: (deps: ProxyDeps) => (c: Parameters<ReturnType<typeof chatCompletions>>[0]) => Promise<Response>,
) {
  const app = new Hono<GatewayAuthEnv>();
  app.use("*", async (c, next) => {
    c.set("gatewayTenant", {
      id: "tenant-1",
      spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
    } as never);
    await next();
  });
  app.post(path, handler(deps) as never);
  return app;
}

// ---------------------------------------------------------------------------
// chatCompletions
// ---------------------------------------------------------------------------

describe("chatCompletions", () => {
  it("proxies non-streaming request to openrouter and returns 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hello!" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: "openai/gpt-4o-mini",
        }),
        {
          status: 200,
          headers: new Headers({
            "Content-Type": "application/json",
            "x-openrouter-cost": "0.001",
          }),
        },
      ),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello!");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mock.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns 402 when budget check fails", async () => {
    const deps = makeDeps({
      budgetChecker: {
        check: vi.fn(() => ({ allowed: false, reason: "Budget exceeded" })),
      } as never,
    });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("insufficient_credits");
  });

  it("returns 402 when credit balance is zero", async () => {
    const deps = makeDeps({
      creditLedger: {
        balance: vi.fn(() => Credit.fromCents(0)),
        debit: vi.fn(),
      } as never,
    });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("insufficient_credits");
  });

  it("emits meter event with correct capability and provider on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: new Headers({ "x-openrouter-cost": "0.002" }),
        },
      ),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(deps.meter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: "tenant-1",
        capability: "chat-completions",
        provider: "openrouter",
      }),
    );
  });

  it("returns 503 when openrouter is not configured", async () => {
    const deps = makeDeps({ providers: {} });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("service_unavailable");
  });

  it("returns 502 when upstream fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_error");
  });

  it("does not emit meter event when upstream returns non-ok status", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "bad request" }), { status: 400 }));

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(deps.meter.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// chatCompletions streaming
// ---------------------------------------------------------------------------

describe("chatCompletions streaming", () => {
  it("returns text/event-stream content-type for streaming requests", async () => {
    const sseBody = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });
});

// ---------------------------------------------------------------------------
// audioTranscriptions
// ---------------------------------------------------------------------------

describe("audioTranscriptions", () => {
  it("proxies audio to deepgram and returns transcription", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "hello world" }] }] },
          metadata: { duration: 10.5 },
        }),
        { status: 200 },
      ),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/audio/transcriptions", audioTranscriptions);

    const res = await app.request("/audio/transcriptions?model=nova-2", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new ArrayBuffer(100),
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("mock-dg.test/v1/listen"),
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "audio/wav" }),
      }),
    );
  });

  it("returns 503 when deepgram is not configured", async () => {
    const deps = makeDeps({ providers: { openrouter: { apiKey: "k", baseUrl: "http://x" } } });
    const app = makeApp(deps, "/audio/transcriptions", audioTranscriptions);

    const res = await app.request("/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new ArrayBuffer(10),
    });

    expect(res.status).toBe(503);
  });

  it("emits meter event with duration-based usage on success", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ metadata: { duration: 60 } }), { status: 200 }));

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/audio/transcriptions", audioTranscriptions);

    await app.request("/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new ArrayBuffer(10),
    });

    expect(deps.meter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "transcription",
        provider: "deepgram",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// audioSpeech (TTS via ElevenLabs fallback — no arbitrageRouter)
// ---------------------------------------------------------------------------

describe("audioSpeech", () => {
  it("proxies TTS request to elevenlabs and returns audio", async () => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(audioBytes.buffer, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    );

    const deps = makeDeps({ fetchFn: mockFetch, arbitrageRouter: undefined });
    const app = makeApp(deps, "/audio/speech", audioSpeech);

    const res = await app.request("/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Hello world", voice: "test-voice" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("mock-el.test/v1/text-to-speech/test-voice"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns 400 for invalid JSON body", async () => {
    const deps = makeDeps({ arbitrageRouter: undefined });
    const app = makeApp(deps, "/audio/speech", audioSpeech);

    const res = await app.request("/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("parse_error");
  });

  it("emits meter event with character count on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    );

    const deps = makeDeps({ fetchFn: mockFetch, arbitrageRouter: undefined });
    const app = makeApp(deps, "/audio/speech", audioSpeech);

    await app.request("/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Test text" }),
    });

    expect(deps.meter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "tts",
        provider: "elevenlabs",
      }),
    );
  });

  it("returns 503 when elevenlabs is not configured and no arbitrage router", async () => {
    const deps = makeDeps({
      providers: { openrouter: { apiKey: "k", baseUrl: "http://x" } },
      arbitrageRouter: undefined,
    });
    const app = makeApp(deps, "/audio/speech", audioSpeech);

    const res = await app.request("/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Test" }),
    });

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// imageGenerations
// ---------------------------------------------------------------------------

describe("imageGenerations", () => {
  it("proxies image request to replicate and returns OpenAI-compatible format", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: ["https://example.com/image.png"],
          metrics: { predict_time: 3.5 },
        }),
        { status: 200 },
      ),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/images/generations", imageGenerations);

    const res = await app.request("/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "A cat", size: "512x512" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].url).toBe("https://example.com/image.png");
  });

  it("returns 502 when replicate returns non-ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/images/generations", imageGenerations);

    const res = await app.request("/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "A cat" }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_error");
  });

  it("emits meter event with image count on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: ["https://img.test/1.png"], metrics: { predict_time: 2 } }), {
        status: 200,
      }),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/images/generations", imageGenerations);

    await app.request("/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "A dog", n: 2 }),
    });

    expect(deps.meter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "image-generation",
        provider: "replicate",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// textCompletions
// ---------------------------------------------------------------------------

describe("textCompletions", () => {
  it("proxies text completion and returns response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ text: "completed text" }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: new Headers({ "x-openrouter-cost": "0.001" }),
        },
      ),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/completions", textCompletions);

    const res = await app.request("/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-3.5-turbo-instruct", prompt: "Hello" }),
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mock.test/v1/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns 402 when budget denied", async () => {
    const deps = makeDeps({
      budgetChecker: {
        check: vi.fn(() => ({ allowed: false, reason: "Budget exceeded" })),
      } as never,
    });
    const app = makeApp(deps, "/completions", textCompletions);

    const res = await app.request("/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hi" }),
    });

    expect(res.status).toBe(402);
  });
});

// ---------------------------------------------------------------------------
// embeddings
// ---------------------------------------------------------------------------

describe("embeddings", () => {
  it("proxies embedding request and returns response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: { total_tokens: 5 },
          model: "text-embedding-3-small",
        }),
        {
          status: 200,
          headers: new Headers({ "x-openrouter-cost": "0.0001" }),
        },
      ),
    );

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/embeddings", embeddings);

    const res = await app.request("/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Hello world", model: "text-embedding-3-small" }),
    });

    expect(res.status).toBe(200);
    expect(deps.meter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "embeddings",
        provider: "openrouter",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Error mapping via mapProviderError (exercised through chatCompletions)
// ---------------------------------------------------------------------------

describe("error mapping via mapProviderError", () => {
  it("maps upstream 429 to rate_limit_error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(Object.assign(new Error("Too many requests"), { httpStatus: 429 }));

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("maps generic fetch error to 502 upstream_error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("upstream_error");
  });

  it("maps spending limit error to billing_error", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Exceeded spending limit on provider"), { httpStatus: 429 }));

    const deps = makeDeps({ fetchFn: mockFetch });
    const app = makeApp(deps, "/chat/completions", chatCompletions);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("billing_error");
  });
});
