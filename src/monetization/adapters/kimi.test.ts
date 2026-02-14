import { describe, expect, it, vi } from "vitest";
import type { FetchFn, KimiAdapterConfig } from "./kimi.js";
import { createKimiAdapter } from "./kimi.js";
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

/** A successful Kimi chat completion response */
function chatCompletionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmpl-abc123",
    model: "kimi-k3",
    choices: [
      {
        message: {
          content: "Hello! How can I help you today?",
        },
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<KimiAdapterConfig> = {}): KimiAdapterConfig {
  return {
    apiKey: "test-moonshot-api-key",
    baseUrl: "https://api.moonshot.cn",
    defaultModel: "kimi-k3",
    marginMultiplier: 1.3,
    inputTokenCostPer1M: 0.35,
    outputTokenCostPer1M: 1.4,
    ...overrides,
  };
}

describe("createKimiAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockResponse({}));
    const adapter = createKimiAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("kimi");
    expect(adapter.capabilities).toEqual(["text-generation"]);
  });

  describe("generateText", () => {
    it("calculates cost from token counts", async () => {
      const response = chatCompletionResponse({
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig({ inputTokenCostPer1M: 0.35, outputTokenCostPer1M: 1.4 }), fetchFn);
      const result = await adapter.generateText({ prompt: "Hello" });

      // (1000 / 1M) * $0.35 + (500 / 1M) * $1.40 = $0.00035 + $0.0007 = $0.00105
      expect(result.cost).toBeCloseTo(0.00105, 6);
    });

    it("applies margin correctly", async () => {
      const response = chatCompletionResponse({
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(
        makeConfig({ marginMultiplier: 1.5, inputTokenCostPer1M: 0.35, outputTokenCostPer1M: 1.4 }),
        fetchFn,
      );
      const result = await adapter.generateText({ prompt: "test" });

      const expectedCost = 0.00105;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.charge).toBeCloseTo(withMargin(expectedCost, 1.5), 6);
    });

    it("supports model override via input", async () => {
      const response = chatCompletionResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({
        prompt: "Explain monads",
        model: "moonshot-v1-128k",
      });

      // Verify model sent in body
      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.model).toBe("moonshot-v1-128k");

      // Verify model returned in result
      expect(result.result.model).toBe("moonshot-v1-128k");
    });

    it("uses default model when none specified", async () => {
      const response = chatCompletionResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig({ defaultModel: "kimi-k3" }), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.model).toBe("kimi-k3");
    });

    it("sends correct request format", async () => {
      const response = chatCompletionResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      await adapter.generateText({
        prompt: "Hello world",
        maxTokens: 500,
        temperature: 0.7,
      });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect(init?.method).toBe("POST");

      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Authorization).toBe("Bearer test-moonshot-api-key");

      const body = JSON.parse(init?.body as string);
      expect(body.messages).toEqual([{ role: "user", content: "Hello world" }]);
      expect(body.max_tokens).toBe(500);
      expect(body.temperature).toBe(0.7);
    });

    it("does not send optional params when not provided", async () => {
      const response = chatCompletionResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBeUndefined();
    });

    it("passes temperature=0 correctly", async () => {
      const response = chatCompletionResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test", temperature: 0 });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.temperature).toBe(0);
    });

    it("returns token usage from response", async () => {
      const response = chatCompletionResponse({
        usage: { prompt_tokens: 25, completion_tokens: 100 },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.result.usage.inputTokens).toBe(25);
      expect(result.result.usage.outputTokens).toBe(100);
    });

    it("handles missing usage in response", async () => {
      const response = chatCompletionResponse({ usage: undefined });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.result.usage.inputTokens).toBe(0);
      expect(result.result.usage.outputTokens).toBe(0);
      expect(result.cost).toBe(0);
    });

    it("throws on API error with message", async () => {
      const errorBody = { error: { message: "Invalid API key", type: "authentication_error" } };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(errorBody, 401));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "test" })).rejects.toThrow("Kimi API error (401)");
    });

    it("throws on 429 rate limit with retry-after", async () => {
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ error: "rate limit exceeded" }, 429, { "retry-after": "30" }));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      try {
        await adapter.generateText({ prompt: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter: string };
        expect(error.message).toBe("Kimi rate limit exceeded");
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBe("30");
      }
    });

    it("handles 429 without retry-after header", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "rate limit exceeded" }, 429));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      try {
        await adapter.generateText({ prompt: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter?: string };
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBeUndefined();
      }
    });

    it("throws on 500 server error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "Internal error" }, 500));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "test" })).rejects.toThrow("Kimi API error (500)");
    });

    it("uses custom baseUrl", async () => {
      const response = chatCompletionResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig({ baseUrl: "https://custom.moonshot.cn" }), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const url = fetchFn.mock.calls[0][0] as string;
      expect(url).toBe("https://custom.moonshot.cn/v1/chat/completions");
    });

    it("extracts text from response choices", async () => {
      const response = chatCompletionResponse({
        choices: [
          {
            message: {
              content: "The answer is 42.",
            },
          },
        ],
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createKimiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "What is the answer?" });

      expect(result.result.text).toBe("The answer is 42.");
    });
  });
});
