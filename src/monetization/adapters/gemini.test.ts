import { describe, expect, it, vi } from "vitest";
import { Credit } from "../credit.js";
import type { FetchFn, GeminiAdapterConfig } from "./gemini.js";
import { createGeminiAdapter } from "./gemini.js";
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

/** A successful Gemini generateContent response */
function generateContentResponse(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: "Hello! How can I help you today?" }],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 8,
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GeminiAdapterConfig> = {}): GeminiAdapterConfig {
  return {
    apiKey: "test-google-api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.0-flash",
    marginMultiplier: 1.3,
    inputTokenCostPer1M: 0.1,
    outputTokenCostPer1M: 0.4,
    ...overrides,
  };
}

describe("createGeminiAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockResponse({}));
    const adapter = createGeminiAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("gemini");
    expect(adapter.capabilities).toEqual(["text-generation"]);
  });

  describe("generateText", () => {
    it("calculates cost from token counts", async () => {
      const response = generateContentResponse({
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig({ inputTokenCostPer1M: 0.1, outputTokenCostPer1M: 0.4 }), fetchFn);
      const result = await adapter.generateText({ prompt: "Hello" });

      // (1000 / 1M) * $0.10 + (500 / 1M) * $0.40 = $0.0001 + $0.0002 = $0.0003
      expect(result.cost.toDollars()).toBeCloseTo(0.0003, 6);
    });

    it("applies margin correctly", async () => {
      const response = generateContentResponse({
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(
        makeConfig({ marginMultiplier: 1.5, inputTokenCostPer1M: 0.1, outputTokenCostPer1M: 0.4 }),
        fetchFn,
      );
      const result = await adapter.generateText({ prompt: "test" });

      const expectedCost = 0.0003;
      expect(result.cost.toDollars()).toBeCloseTo(expectedCost, 6);
      expect(result.charge?.toDollars()).toBeCloseTo(withMargin(Credit.fromDollars(expectedCost), 1.5).toDollars(), 6);
    });

    it("supports model override via input", async () => {
      const response = generateContentResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({
        prompt: "Explain monads",
        model: "gemini-2.5-pro",
      });

      // Verify model used in URL
      const url = fetchFn.mock.calls[0][0] as string;
      expect(url).toContain("/models/gemini-2.5-pro:");

      // Verify model returned in result
      expect(result.result.model).toBe("gemini-2.5-pro");
    });

    it("uses default model when none specified", async () => {
      const response = generateContentResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig({ defaultModel: "gemini-2.0-flash" }), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const url = fetchFn.mock.calls[0][0] as string;
      expect(url).toContain("/models/gemini-2.0-flash:");
    });

    it("sends correct request format", async () => {
      const response = generateContentResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      await adapter.generateText({
        prompt: "Hello world",
        maxTokens: 500,
        temperature: 0.7,
      });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toContain("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
      expect(url).toContain("key=test-google-api-key");
      expect(init?.method).toBe("POST");

      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init?.body as string);
      expect(body.contents).toEqual([{ parts: [{ text: "Hello world" }] }]);
      expect(body.generationConfig.maxOutputTokens).toBe(500);
      expect(body.generationConfig.temperature).toBe(0.7);
    });

    it("does not send generationConfig when not needed", async () => {
      const response = generateContentResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.generationConfig).toBeUndefined();
    });

    it("passes temperature=0 correctly", async () => {
      const response = generateContentResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test", temperature: 0 });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.generationConfig.temperature).toBe(0);
    });

    it("returns token usage from response", async () => {
      const response = generateContentResponse({
        usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 100 },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.result.usage.inputTokens).toBe(25);
      expect(result.result.usage.outputTokens).toBe(100);
    });

    it("handles missing usageMetadata in response", async () => {
      const response = generateContentResponse({ usageMetadata: undefined });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.result.usage.inputTokens).toBe(0);
      expect(result.result.usage.outputTokens).toBe(0);
      expect(result.cost.isZero()).toBe(true);
    });

    it("throws on API error with message", async () => {
      const errorBody = { error: { message: "API key not valid", status: "INVALID_ARGUMENT" } };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(errorBody, 400));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "test" })).rejects.toThrow("Gemini API error (400)");
    });

    it("throws on 429 rate limit with retry-after", async () => {
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ error: "quota exceeded" }, 429, { "retry-after": "60" }));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      try {
        await adapter.generateText({ prompt: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter: string };
        expect(error.message).toBe("Gemini rate limit exceeded");
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBe("60");
      }
    });

    it("handles 429 without retry-after header", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "quota exceeded" }, 429));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
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

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "test" })).rejects.toThrow("Gemini API error (500)");
    });

    it("uses custom baseUrl", async () => {
      const response = generateContentResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig({ baseUrl: "https://custom.googleapis.com" }), fetchFn);
      await adapter.generateText({ prompt: "test" });

      const url = fetchFn.mock.calls[0][0] as string;
      expect(url).toContain("https://custom.googleapis.com/v1beta/models/");
    });

    it("extracts text from response candidates", async () => {
      const response = generateContentResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "The answer is 42." }],
            },
          },
        ],
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createGeminiAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "What is the answer?" });

      expect(result.result.text).toBe("The answer is 42.");
    });
  });
});
