import { describe, expect, it, vi } from "vitest";
import type { FetchFn, OpenRouterAdapterConfig } from "./openrouter.js";
import { createOpenRouterAdapter } from "./openrouter.js";
import { withMargin } from "./types.js";

/** Helper to create a mock Response with headers */
function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const headerMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: {
      get: (name: string) => headerMap.get(name) ?? null,
    },
  } as Response;
}

/** A successful OpenAI-compatible chat completion response */
function chatCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-abc123",
    model: "openai/gpt-4o-mini",
    choices: [
      {
        message: { content: "Hello! How can I help you today?" },
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OpenRouterAdapterConfig> = {}): OpenRouterAdapterConfig {
  return {
    apiKey: "sk-or-v1-test-key",
    baseUrl: "https://openrouter.ai/api",
    defaultModel: "openai/gpt-4o-mini",
    marginMultiplier: 1.3,
    ...overrides,
  };
}

describe("createOpenRouterAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockResponse({}));
    const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("openrouter");
    expect(adapter.capabilities).toEqual(["text-generation", "embeddings"]);
  });

  describe("generateText", () => {
    it("extracts cost from x-openrouter-cost header", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.000042" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "Hello" });

      expect(result.cost).toBeCloseTo(0.000042, 6);
      expect(result.charge).toBeCloseTo(withMargin(0.000042, 1.3), 6);
    });

    it("applies margin to header cost", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.01" }));

      const adapter = createOpenRouterAdapter(makeConfig({ marginMultiplier: 1.5 }), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.cost).toBeCloseTo(0.01, 6);
      expect(result.charge).toBeCloseTo(withMargin(0.01, 1.5), 6);
    });

    it("passes requested model through to response", async () => {
      const completion = chatCompletion({ model: "anthropic/claude-sonnet-4-5-20250929" });
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.003" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({
        prompt: "Explain monads",
        model: "anthropic/claude-sonnet-4-5-20250929",
      });

      // Verify model sent in request body
      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.model).toBe("anthropic/claude-sonnet-4-5-20250929");

      // Verify model from response is returned
      expect(result.result.model).toBe("anthropic/claude-sonnet-4-5-20250929");
    });

    it("auto model routing returns actual model used", async () => {
      // When "auto" is requested, OpenRouter picks the best model
      const completion = chatCompletion({ model: "openai/gpt-4o" });
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.005" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({
        prompt: "test",
        model: "auto",
      });

      // Request sent "auto"
      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.model).toBe("auto");

      // Response contains the actual model OpenRouter chose
      expect(result.result.model).toBe("openai/gpt-4o");
    });

    it("falls back to token-based calculation when cost header is missing", async () => {
      const completion = chatCompletion({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(completion, 200));

      const adapter = createOpenRouterAdapter(
        makeConfig({
          fallbackInputTokenCost: 0.000001,
          fallbackOutputTokenCost: 0.000002,
        }),
        fetchFn,
      );
      const result = await adapter.generateText({ prompt: "test" });

      // 100 * $0.000001 + 50 * $0.000002 = $0.0001 + $0.0001 = $0.0002
      expect(result.cost).toBeCloseTo(0.0002, 6);
      expect(result.charge).toBeCloseTo(withMargin(0.0002, 1.3), 6);
    });

    it("propagates 429 rate limit error with retry-after", async () => {
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ error: "rate limited" }, 429, { "retry-after": "30" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      try {
        await adapter.generateText({ prompt: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter: string };
        expect(error.message).toBe("OpenRouter rate limit exceeded");
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBe("30");
      }
    });

    it("sends custom appUrl and appName in headers", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(
        makeConfig({
          appUrl: "https://wopr.network",
          appName: "WOPR Platform",
        }),
        fetchFn,
      );
      await adapter.generateText({ prompt: "test" });

      const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["HTTP-Referer"]).toBe("https://wopr.network");
      expect(headers["X-Title"]).toBe("WOPR Platform");
    });

    it("does not send appUrl/appName headers when not configured", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["HTTP-Referer"]).toBeUndefined();
      expect(headers["X-Title"]).toBeUndefined();
    });

    it("uses default model when none specified in input", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(makeConfig({ defaultModel: "meta-llama/llama-3-8b" }), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.model).toBe("meta-llama/llama-3-8b");
    });

    it("sends correct request format (OpenAI-compatible)", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await adapter.generateText({
        prompt: "Hello world",
        maxTokens: 500,
        temperature: 0.7,
      });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(init?.method).toBe("POST");

      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-or-v1-test-key");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("openai/gpt-4o-mini");
      expect(body.messages).toEqual([{ role: "user", content: "Hello world" }]);
      expect(body.max_tokens).toBe(500);
      expect(body.temperature).toBe(0.7);
    });

    it("passes temperature=0 correctly", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test", temperature: 0 });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.temperature).toBe(0);
    });

    it("does not send max_tokens when not specified", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBeUndefined();
    });

    it("returns token usage from response", async () => {
      const completion = chatCompletion({
        usage: { prompt_tokens: 25, completion_tokens: 100 },
      });
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.005" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.result.usage.inputTokens).toBe(25);
      expect(result.result.usage.outputTokens).toBe(100);
    });

    it("handles missing usage in response", async () => {
      const completion = chatCompletion({ usage: undefined });
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.result.usage.inputTokens).toBe(0);
      expect(result.result.usage.outputTokens).toBe(0);
    });

    it("throws on non-429 API error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "Unauthorized" }, 401));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "test" })).rejects.toThrow("OpenRouter API error (401)");
    });

    it("throws on 500 server error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "Internal server error" }, 500));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "test" })).rejects.toThrow("OpenRouter API error (500)");
    });

    it("handles 429 without retry-after header", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "rate limited" }, 429));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      try {
        await adapter.generateText({ prompt: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter?: string };
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBeUndefined();
      }
    });

    it("uses custom baseUrl", async () => {
      const completion = chatCompletion();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(completion, 200, { "x-openrouter-cost": "0.001" }));

      const adapter = createOpenRouterAdapter(makeConfig({ baseUrl: "https://custom.openrouter.ai/api" }), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe("https://custom.openrouter.ai/api/v1/chat/completions");
    });
  });

  describe("embed", () => {
    /** A successful OpenAI-compatible embeddings response */
    function embeddingsResponse(overrides: Record<string, unknown> = {}) {
      return {
        model: "openai/text-embedding-3-small",
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        usage: { total_tokens: 5 },
        ...overrides,
      };
    }

    it("calls /v1/embeddings endpoint", async () => {
      const body = embeddingsResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(body, 200, { "x-openrouter-cost": "0.00001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await adapter.embed({ input: "Hello world" });

      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
      expect(init?.method).toBe("POST");
    });

    it("extracts cost from x-openrouter-cost header", async () => {
      const body = embeddingsResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(body, 200, { "x-openrouter-cost": "0.000015" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.embed({ input: "test" });

      expect(result.cost).toBeCloseTo(0.000015, 6);
    });

    it("applies margin correctly", async () => {
      const body = embeddingsResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(body, 200, { "x-openrouter-cost": "0.01" }));

      const adapter = createOpenRouterAdapter(makeConfig({ marginMultiplier: 1.5 }), fetchFn);
      const result = await adapter.embed({ input: "test" });

      expect(result.cost).toBeCloseTo(0.01, 6);
      expect(result.charge).toBeCloseTo(withMargin(0.01, 1.5), 6);
    });

    it("passes model and dimensions through to request", async () => {
      const body = embeddingsResponse({ model: "openai/text-embedding-3-large" });
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(body, 200, { "x-openrouter-cost": "0.00002" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.embed({
        input: "test",
        model: "openai/text-embedding-3-large",
        dimensions: 256,
      });

      const reqBody = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(reqBody.model).toBe("openai/text-embedding-3-large");
      expect(reqBody.dimensions).toBe(256);
      expect(result.result.model).toBe("openai/text-embedding-3-large");
    });

    it("handles batch input (string[])", async () => {
      const body = embeddingsResponse({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
        usage: { total_tokens: 10 },
      });
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(body, 200, { "x-openrouter-cost": "0.00003" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      const result = await adapter.embed({ input: ["Hello", "World"] });

      const reqBody = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(reqBody.input).toEqual(["Hello", "World"]);
      expect(result.result.embeddings).toHaveLength(2);
      expect(result.result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(result.result.embeddings[1]).toEqual([0.4, 0.5, 0.6]);
      expect(result.result.totalTokens).toBe(10);
    });

    it("propagates 429 rate limit error", async () => {
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ error: "rate limited" }, 429, { "retry-after": "15" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      try {
        await adapter.embed({ input: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter: string };
        expect(error.message).toBe("OpenRouter rate limit exceeded");
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBe("15");
      }
    });

    it("uses default model when none specified", async () => {
      const body = embeddingsResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(body, 200, { "x-openrouter-cost": "0.00001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await adapter.embed({ input: "test" });

      const reqBody = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(reqBody.model).toBe("openai/text-embedding-3-small");
    });

    it("falls back to token-based cost when header is missing", async () => {
      const body = embeddingsResponse({ usage: { total_tokens: 100 } });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(body, 200));

      const adapter = createOpenRouterAdapter(
        makeConfig({ fallbackInputTokenCost: 0.000001 }),
        fetchFn,
      );
      const result = await adapter.embed({ input: "test" });

      // 100 tokens * $0.000001 = $0.0001
      expect(result.cost).toBeCloseTo(0.0001, 6);
      expect(result.charge).toBeCloseTo(withMargin(0.0001, 1.3), 6);
    });

    it("does not send dimensions when not specified", async () => {
      const body = embeddingsResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(body, 200, { "x-openrouter-cost": "0.00001" }));

      const adapter = createOpenRouterAdapter(makeConfig(), fetchFn);
      await adapter.embed({ input: "test" });

      const reqBody = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(reqBody.dimensions).toBeUndefined();
    });
  });
});
