import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetCheckResult, SpendLimits } from "../../monetization/budget/budget-checker.js";
import type { MeterEvent } from "../../monetization/metering/types.js";
import type { GatewayTenant } from "../types.js";
import { createAnthropicRoutes } from "./anthropic.js";
import type { ProtocolDeps } from "./deps.js";
import { createOpenAIRoutes } from "./openai.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_TENANT: GatewayTenant = {
  id: "tenant-001",
  spendLimits: { maxSpendPerHour: 100, maxSpendPerMonth: 1000 },
};

const VALID_KEY = "wopr-sk-test-valid-key";

function createMockDeps(overrides?: Partial<ProtocolDeps>): ProtocolDeps & { meterEvents: MeterEvent[] } {
  const meterEvents: MeterEvent[] = [];
  return {
    meterEvents,
    meter: {
      emit: vi.fn((event: MeterEvent) => meterEvents.push(event)),
    } as unknown as ProtocolDeps["meter"],
    budgetChecker: {
      check: vi.fn(
        (_tenantId: string, _limits: SpendLimits): BudgetCheckResult => ({
          allowed: true,
          currentHourlySpend: 0,
          currentMonthlySpend: 0,
          maxSpendPerHour: 100,
          maxSpendPerMonth: 1000,
        }),
      ),
    } as unknown as ProtocolDeps["budgetChecker"],
    providers: {
      openrouter: { apiKey: "or-test-key", baseUrl: "https://mock-openrouter.test" },
    },
    defaultMargin: 1.3,
    fetchFn: vi.fn(),
    resolveServiceKey: vi.fn((key: string) => (key === VALID_KEY ? TEST_TENANT : null)),
    withMarginFn: vi.fn((cost: number, margin: number) => cost * margin),
    ...overrides,
  };
}

/** Build a successful OpenAI chat completion response. */
function openaiChatResponse(content: string) {
  return {
    id: "chatcmpl-test123",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function mockFetchOk(body: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  );
}

function mockFetchError(status: number, body: string) {
  return vi.fn().mockResolvedValue(new Response(body, { status, headers: { "Content-Type": "text/plain" } }));
}

function mockFetchStream(sseData: string, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue(
    new Response(sseData, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", ...headers },
    }),
  );
}

// ---------------------------------------------------------------------------
// Anthropic Handler Tests
// ---------------------------------------------------------------------------

describe("Anthropic protocol handler", () => {
  let app: Hono;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    app = new Hono();
    app.route("/v1/anthropic", createAnthropicRoutes(deps));
  });

  describe("authentication", () => {
    it("rejects requests without x-api-key", async () => {
      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("authentication_error");
    });

    it("rejects invalid x-api-key", async () => {
      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", "x-api-key": "invalid-key" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.type).toBe("authentication_error");
    });

    it("accepts valid x-api-key", async () => {
      deps.fetchFn = mockFetchOk(openaiChatResponse("Hello!"));

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 100,
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(res.status).toBe(200);
    });

    it("accepts Authorization: Bearer as fallback", async () => {
      deps.fetchFn = mockFetchOk(openaiChatResponse("Hello!"));

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 100,
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(res.status).toBe(200);
    });
  });

  describe("request validation", () => {
    it("returns 400 for missing required fields", async () => {
      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-3-5-sonnet-20241022" }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("invalid_request_error");
    });
  });

  describe("format translation", () => {
    it("translates Anthropic request to OpenAI and response back", async () => {
      deps.fetchFn = mockFetchOk(openaiChatResponse("Translated response!"));

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1024,
          system: "You are helpful.",
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(res.status).toBe(200);

      const body = await res.json();
      // Response should be in Anthropic format
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(body.content[0].type).toBe("text");
      expect(body.content[0].text).toBe("Translated response!");
      expect(body.stop_reason).toBe("end_turn");
      expect(body.usage.input_tokens).toBe(10);
      expect(body.usage.output_tokens).toBe(5);

      // Verify the upstream request was translated to OpenAI format
      const fetchCall = vi.mocked(deps.fetchFn).mock.calls[0];
      expect(fetchCall[0]).toBe("https://mock-openrouter.test/v1/chat/completions");
      const upstreamBody = JSON.parse(fetchCall[1]?.body as string);
      expect(upstreamBody.messages[0]).toEqual({ role: "system", content: "You are helpful." });
      expect(upstreamBody.messages[1]).toEqual({ role: "user", content: "Hello" });
    });
  });

  describe("metering", () => {
    it("emits meter event on success", async () => {
      deps.fetchFn = mockFetchOk(openaiChatResponse("Hello!"), {
        "x-openrouter-cost": "0.005",
      });

      await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 100,
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(deps.meterEvents).toHaveLength(1);
      expect(deps.meterEvents[0].tenant).toBe("tenant-001");
      expect(deps.meterEvents[0].cost).toBe(0.005);
      expect(deps.meterEvents[0].capability).toBe("chat-completions");
    });
  });

  describe("budget checking", () => {
    it("returns 429 when budget exceeded", async () => {
      deps.budgetChecker.check = vi.fn(() => ({
        allowed: false,
        reason: "Monthly spending limit exceeded",
        httpStatus: 429,
        currentHourlySpend: 50,
        currentMonthlySpend: 1000,
        maxSpendPerHour: 100,
        maxSpendPerMonth: 1000,
      }));

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 100,
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.type).toBe("rate_limit_error");
    });
  });

  describe("upstream errors", () => {
    it("maps upstream errors to Anthropic error format", async () => {
      deps.fetchFn = mockFetchError(503, "Service unavailable");

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 100,
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      // 503 maps to 529 (Anthropic overloaded)
      expect(res.status).toBe(529);
      const body = await res.json();
      expect(body.type).toBe("error");
    });
  });

  describe("streaming", () => {
    it("pipes upstream response without JSON parsing when stream is true", async () => {
      const ssePayload = 'data: {"type":"content_block_delta"}\n\ndata: [DONE]\n\n';
      deps.fetchFn = mockFetchStream(ssePayload);

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 100,
          stream: true,
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      const body = await res.text();
      expect(body).toBe(ssePayload);
    });

    it("does not attempt JSON parsing for streaming response", async () => {
      // SSE data is not valid JSON - if the handler tried to parse it, it would throw
      const ssePayload = "data: {partial}\n\ndata: [DONE]\n\n";
      deps.fetchFn = mockFetchStream(ssePayload);

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Stream me" }],
          max_tokens: 200,
          stream: true,
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      // Should succeed without JSON parse errors
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("[DONE]");
    });
  });

  describe("provider not configured", () => {
    it("returns 529 when no provider configured", async () => {
      deps.providers = {};

      const res = await app.request("/v1/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 100,
        }),
        headers: { "Content-Type": "application/json", "x-api-key": VALID_KEY },
      });

      expect(res.status).toBe(529);
    });
  });
});

// ---------------------------------------------------------------------------
// OpenAI Handler Tests
// ---------------------------------------------------------------------------

describe("OpenAI protocol handler", () => {
  let app: Hono;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    app = new Hono();
    app.route("/v1/openai", createOpenAIRoutes(deps));
  });

  describe("authentication", () => {
    it("rejects requests without Authorization header", async () => {
      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("missing_api_key");
    });

    it("rejects non-Bearer Authorization", async () => {
      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", Authorization: "Basic abc" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_auth_format");
    });

    it("rejects invalid Bearer key", async () => {
      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-key" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_api_key");
    });

    it("accepts valid Bearer key", async () => {
      deps.fetchFn = mockFetchOk(openaiChatResponse("Hi!"));

      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(res.status).toBe(200);
    });
  });

  describe("chat completions", () => {
    it("proxies request to OpenRouter and returns response", async () => {
      const upstream = openaiChatResponse("Hello from OpenAI!");
      deps.fetchFn = mockFetchOk(upstream);

      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Response should be unchanged OpenAI format
      expect(body.choices[0].message.content).toBe("Hello from OpenAI!");
      expect(body.usage.prompt_tokens).toBe(10);
    });

    it("passes the request body through to upstream", async () => {
      deps.fetchFn = mockFetchOk(openaiChatResponse("x"));

      const requestBody = JSON.stringify({
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
        ],
        temperature: 0.5,
      });

      await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: requestBody,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      const fetchCall = vi.mocked(deps.fetchFn).mock.calls[0];
      expect(fetchCall[0]).toBe("https://mock-openrouter.test/v1/chat/completions");
      expect(fetchCall[1]?.body).toBe(requestBody);
    });
  });

  describe("embeddings", () => {
    it("proxies embeddings request", async () => {
      const embeddingResponse = {
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 5, total_tokens: 5 },
      };
      deps.fetchFn = mockFetchOk(embeddingResponse);

      const res = await app.request("/v1/openai/v1/embeddings", {
        method: "POST",
        body: JSON.stringify({ model: "text-embedding-3-small", input: "Hello world" }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("metering", () => {
    it("emits meter event on success", async () => {
      deps.fetchFn = mockFetchOk(openaiChatResponse("x"), {
        "x-openrouter-cost": "0.003",
      });

      await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hi" }],
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(deps.meterEvents).toHaveLength(1);
      expect(deps.meterEvents[0].tenant).toBe("tenant-001");
      expect(deps.meterEvents[0].cost).toBe(0.003);
    });

    it("does not emit meter event on upstream error", async () => {
      deps.fetchFn = mockFetchError(500, "Internal error");

      await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hi" }],
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(deps.meterEvents).toHaveLength(0);
    });
  });

  describe("budget checking", () => {
    it("returns 429 when budget exceeded", async () => {
      deps.budgetChecker.check = vi.fn(() => ({
        allowed: false,
        reason: "Hourly spending limit exceeded",
        httpStatus: 429,
        currentHourlySpend: 100,
        currentMonthlySpend: 500,
        maxSpendPerHour: 100,
        maxSpendPerMonth: 1000,
      }));

      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hi" }],
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe("insufficient_quota");
    });
  });

  describe("streaming", () => {
    it("pipes upstream SSE response when stream is true", async () => {
      const ssePayload = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
      deps.fetchFn = mockFetchStream(ssePayload);

      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      const body = await res.text();
      expect(body).toBe(ssePayload);
    });

    it("skips cost estimation for streaming responses", async () => {
      const ssePayload = "data: {not json}\n\ndata: [DONE]\n\n";
      deps.fetchFn = mockFetchStream(ssePayload);

      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      // Should succeed — no JSON parse error from cost estimation
      expect(res.status).toBe(200);
      // No meter event since cost is 0 and no cost header
      expect(deps.meterEvents).toHaveLength(0);
    });

    it("meters streaming cost when x-openrouter-cost header is present", async () => {
      const ssePayload = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
      deps.fetchFn = mockFetchStream(ssePayload, { "x-openrouter-cost": "0.002" });

      await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(deps.meterEvents).toHaveLength(1);
      expect(deps.meterEvents[0].cost).toBe(0.002);
    });
  });

  describe("provider not configured", () => {
    it("returns 503 when no provider", async () => {
      deps.providers = {};

      const res = await app.request("/v1/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hi" }],
        }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
      });

      expect(res.status).toBe(503);
    });
  });
});
