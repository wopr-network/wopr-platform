import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAnthropicRoutes } from "../../src/gateway/protocol/anthropic.js";
import { Credit } from "@wopr-network/platform-core";
import type { GatewayTenant } from "../../src/gateway/types.js";
import type { ProtocolDeps } from "../../src/gateway/protocol/deps.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const TENANT: GatewayTenant = {
  id: "tenant-anthropic-test",
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

function openaiChatResponse(content: string) {
  return {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const VALID_ANTHROPIC_BODY = {
  model: "claude-3-sonnet-20240229",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 100,
};

describe("Anthropic protocol handler", () => {
  let deps: ProtocolDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("auth", () => {
    it("rejects missing x-api-key and Authorization", async () => {
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", { method: "POST" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.error.type).toBe("authentication_error");
    });

    it("accepts x-api-key header", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(openaiChatResponse("Hi")), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(res.status).toBe(200);
    });

    it("accepts Authorization Bearer as fallback", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(openaiChatResponse("Hi")), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { Authorization: "Bearer valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(res.status).toBe(200);
    });

    it("rejects invalid key", async () => {
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "bad-key" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("messages", () => {
    it("translates Anthropic request to OpenAI, forwards, and translates response back", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(openaiChatResponse("Bonjour!")), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(body.content[0].type).toBe("text");
      expect(body.content[0].text).toBe("Bonjour!");
      expect(body.model).toBe("claude-3-sonnet-20240229");
      expect(body.usage.input_tokens).toBe(10);
      expect(body.usage.output_tokens).toBe(5);

      const fetchCall = (deps.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      const sentBody = JSON.parse(fetchCall[1].body as string);
      expect(sentBody.messages[0]).toEqual({ role: "user", content: "Hello" });
    });

    it("returns 400 for invalid JSON body", async () => {
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.message).toContain("Invalid JSON");
    });

    it("returns 400 when missing required fields (model, messages, max_tokens)", async () => {
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-3-sonnet" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.message).toContain("Missing required fields");
    });

    it("returns 429 when budget exceeded", async () => {
      deps = makeDeps({
        budgetChecker: {
          check: vi.fn().mockResolvedValue({ allowed: false, reason: "Over limit" }),
        } as any,
      });
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(res.status).toBe(429);
    });

    it("returns 529 when openrouter provider not configured", async () => {
      deps = makeDeps({ providers: {} });
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(res.status).toBe(529);
    });

    it("maps upstream error to Anthropic error format", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.type).toBe("error");
      expect(body.error.message).toContain("Upstream error");
    });

    it("emits meter event on success", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(openaiChatResponse("Hi")), {
          headers: {
            "Content-Type": "application/json",
            "x-openrouter-cost": "0.005",
          },
        }),
      );
      const app = createAnthropicRoutes(deps);
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(deps.meter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: "tenant-anthropic-test",
          capability: "chat-completions",
          provider: "openrouter",
        }),
      );
    });

    it("returns 500 on fetch error", async () => {
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"));
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ANTHROPIC_BODY),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.type).toBe("error");
    });
  });

  describe("streaming", () => {
    it("pipes SSE stream through when stream: true", async () => {
      const sseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("event: content_block_delta\ndata: {}\n\n"),
          );
          controller.close();
        },
      });
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "x-openrouter-cost": "0.002" },
        }),
      );
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ ...VALID_ANTHROPIC_BODY, stream: true }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("meters streaming cost from header", async () => {
      const sseBody = new ReadableStream({ start(c) { c.close(); } });
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "x-openrouter-cost": "0.01" },
        }),
      );
      const app = createAnthropicRoutes(deps);
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ ...VALID_ANTHROPIC_BODY, stream: true }),
      });
      expect(deps.meter.emit).toHaveBeenCalled();
    });

    it("skips meter when streaming cost is 0", async () => {
      const sseBody = new ReadableStream({ start(c) { c.close(); } });
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
      const app = createAnthropicRoutes(deps);
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({ ...VALID_ANTHROPIC_BODY, stream: true }),
      });
      expect(deps.meter.emit).not.toHaveBeenCalled();
    });
  });

  describe("tool use round-trip", () => {
    it("translates tool use request and response correctly", async () => {
      const openaiToolResponse = {
        id: "chatcmpl-456",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"NYC"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
      (deps.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(openaiToolResponse), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = createAnthropicRoutes(deps);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "valid-key", "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_ANTHROPIC_BODY,
          tools: [
            {
              name: "get_weather",
              description: "Get weather",
              input_schema: { type: "object" },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.stop_reason).toBe("tool_use");
      expect(body.content[0].type).toBe("tool_use");
      expect(body.content[0].name).toBe("get_weather");
      expect(body.content[0].input).toEqual({ city: "NYC" });

      const fetchCall = (deps.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      const sentBody = JSON.parse(fetchCall[1].body as string);
      expect(sentBody.tools[0].type).toBe("function");
      expect(sentBody.tools[0].function.name).toBe("get_weather");
    });
  });
});
