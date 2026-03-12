import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAIRoutes } from "@wopr-network/platform-core/gateway/protocol/openai";
import { Credit } from "@wopr-network/platform-core";
import type { GatewayTenant } from "@wopr-network/platform-core/gateway/types";
import type { ProtocolDeps } from "@wopr-network/platform-core/gateway/protocol/deps";

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const TENANT: GatewayTenant = {
  id: "tenant-openai-test",
  spendLimits: { maxSpendPerHour: 100, maxSpendPerMonth: 1000 },
};

function makeDeps(overrides: Partial<ProtocolDeps> = {}): ProtocolDeps {
  return {
    meter: { emit: vi.fn() } as any,
    budgetChecker: { check: vi.fn().mockResolvedValue({ allowed: true }) } as any,
    creditLedger: undefined,
    topUpUrl: "https://example.com/topup",
    providers: { openrouter: { apiKey: "test-key", baseUrl: "https://fake.test/api" } },
    defaultMargin: 1.3,
    fetchFn: vi.fn(),
    resolveServiceKey: vi.fn((key: string) => (key === "valid-key" ? TENANT : null)),
    withMarginFn: vi.fn((cost: Credit, _margin: number) => cost),
    ...overrides,
  };
}

function openaiResponse(
  content: string,
  usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
) {
  return {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  };
}

describe("OpenAI protocol handler", () => {
  let deps: ProtocolDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("auth", () => {
    it("rejects missing Authorization header", async () => {
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", { method: "POST" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("missing_api_key");
    });

    it("rejects non-Bearer auth format", async () => {
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Basic abc123" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("invalid_auth_format");
    });

    it("rejects whitespace-only Bearer token", async () => {
      // "Bearer " trims to "Bearer" which fails the startsWith("bearer ") check
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      // Trailing space means trim() removes it, so header fails Bearer format check
      expect(body.error.code).toBe("invalid_auth_format");
    });

    it("rejects invalid service key", async () => {
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer bad-key" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("invalid_api_key");
    });

    it("accepts valid Bearer token", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(openaiResponse("Hi")), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer valid-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hi" }] }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("chat completions", () => {
    it("forwards request to openrouter and returns response", async () => {
      const upstreamBody = openaiResponse("Hello!");
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(upstreamBody), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.choices[0].message.content).toBe("Hello!");

      expect(deps.fetchFn).toHaveBeenCalledWith(
        "https://fake.test/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        }),
      );
    });

    it("emits meter event on success", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(openaiResponse("Hi")), {
          headers: {
            "Content-Type": "application/json",
            "x-openrouter-cost": "0.005",
          },
        }),
      );
      const app = createOpenAIRoutes(deps);
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hi" }] }),
      });
      expect(deps.meter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: "tenant-openai-test",
          capability: "chat-completions",
          provider: "openrouter",
        }),
      );
    });

    it("does not emit meter event on upstream error", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ error: "bad" }), { status: 500 }),
      );
      const app = createOpenAIRoutes(deps);
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      expect(deps.meter.emit).not.toHaveBeenCalled();
    });

    it("returns 429 when budget is exceeded", async () => {
      deps = makeDeps({
        budgetChecker: {
          check: vi.fn().mockResolvedValue({ allowed: false, reason: "Over budget" }),
        } as any,
      });
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("insufficient_quota");
    });

    it("returns 503 when openrouter provider is not configured", async () => {
      deps = makeDeps({ providers: {} });
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      expect(res.status).toBe(503);
    });

    it("returns 500 on fetch error", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network down"));
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [] }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.error.message).toBe("Network down");
    });
  });

  describe("streaming", () => {
    it("pipes SSE stream through on stream: true", async () => {
      const sseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
            ),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "x-openrouter-cost": "0.001" },
        }),
      );
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      const text = await res.text();
      expect(text).toContain("data:");
    });

    it("emits meter event for streaming with cost header", async () => {
      const sseBody = new ReadableStream({ start(c) { c.close(); } });
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "x-openrouter-cost": "0.01" },
        }),
      );
      const app = createOpenAIRoutes(deps);
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [], stream: true }),
      });
      expect(deps.meter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: "tenant-openai-test" }),
      );
    });

    it("skips meter when streaming cost is 0", async () => {
      const sseBody = new ReadableStream({ start(c) { c.close(); } });
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
      const app = createOpenAIRoutes(deps);
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [], stream: true }),
      });
      expect(deps.meter.emit).not.toHaveBeenCalled();
    });
  });

  describe("embeddings", () => {
    it("forwards embeddings request and returns response", async () => {
      const embeddingsRes = {
        data: [{ embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      };
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(embeddingsRes), {
          headers: {
            "Content-Type": "application/json",
            "x-openrouter-cost": "0.0001",
          },
        }),
      );
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/embeddings", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: "Hello" }),
      });
      expect(res.status).toBe(200);
      expect(deps.fetchFn).toHaveBeenCalledWith(
        "https://fake.test/api/v1/embeddings",
        expect.anything(),
      );
    });

    it("returns 429 when budget exceeded for embeddings", async () => {
      deps = makeDeps({
        budgetChecker: { check: vi.fn().mockResolvedValue({ allowed: false }) } as any,
      });
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/embeddings", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: "Hello" }),
      });
      expect(res.status).toBe(429);
    });

    it("returns 500 on embeddings fetch error", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"));
      const app = createOpenAIRoutes(deps);
      const res = await app.request("/v1/embeddings", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", input: "x" }),
      });
      expect(res.status).toBe(500);
    });
  });
});
