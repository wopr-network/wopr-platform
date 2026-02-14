import { describe, expect, it, vi } from "vitest";
import type { FetchFn, NanoBananaAdapterConfig } from "./nano-banana.js";
import { createNanoBananaAdapter } from "./nano-banana.js";
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

/** A successful Gemini image generation response */
function imageResponse(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
              },
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<NanoBananaAdapterConfig> = {}): NanoBananaAdapterConfig {
  return {
    apiKey: "test-google-api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
    costPerImage: 0.02,
    marginMultiplier: 1.3,
    ...overrides,
  };
}

describe("createNanoBananaAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockResponse({}));
    const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("nano-banana");
    expect(adapter.capabilities).toEqual(["image-generation"]);
  });

  describe("generateImage", () => {
    it("calls Gemini API and returns base64 images with cost", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateImage({ prompt: "a banana in space" });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toContain(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent",
      );
      expect(url).toContain("key=test-google-api-key");
      expect(init?.method).toBe("POST");

      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init?.body as string);
      expect(body.contents).toEqual([{ parts: [{ text: "a banana in space" }] }]);

      expect(result.result.images).toHaveLength(1);
      expect(result.result.images[0]).toBe("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk");
      expect(result.result.model).toBe("nano-banana");

      // Cost: 1 image * $0.02 = $0.02
      expect(result.cost).toBe(0.02);
      expect(result.charge).toBeCloseTo(withMargin(0.02, 1.3), 6);
    });

    it("calculates cost based on actual images delivered", async () => {
      const response = {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: "image/png", data: "img1" } }] } },
          { content: { parts: [{ inlineData: { mimeType: "image/png", data: "img2" } }] } },
          { content: { parts: [{ inlineData: { mimeType: "image/png", data: "img3" } }] } },
        ],
      };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig({ costPerImage: 0.02 }), fetchFn);
      const result = await adapter.generateImage({ prompt: "bananas", count: 3 });

      // Cost: 3 delivered images * $0.02 = $0.06
      expect(result.result.images).toHaveLength(3);
      expect(result.cost).toBe(0.06);
      expect(result.charge).toBeCloseTo(withMargin(0.06, 1.3), 6);
    });

    it("sends candidateCount when count > 1", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await adapter.generateImage({ prompt: "bananas", count: 4 });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.generationConfig.candidateCount).toBe(4);
    });

    it("does not send candidateCount when count is 1", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await adapter.generateImage({ prompt: "one banana", count: 1 });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.generationConfig.candidateCount).toBeUndefined();
    });

    it("sends responseModalities in generationConfig", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await adapter.generateImage({ prompt: "test" });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.generationConfig.responseModalities).toEqual(["IMAGE", "TEXT"]);
    });

    it("applies custom margin multiplier", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig({ marginMultiplier: 1.5 }), fetchFn);
      const result = await adapter.generateImage({ prompt: "test" });

      expect(result.cost).toBe(0.02);
      expect(result.charge).toBeCloseTo(withMargin(0.02, 1.5), 6);
    });

    it("handles multiple images from multiple candidates", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: "base64_image_1" } }],
            },
          },
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: "base64_image_2" } }],
            },
          },
        ],
      };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateImage({ prompt: "multiple bananas", count: 2 });

      expect(result.result.images).toEqual(["base64_image_1", "base64_image_2"]);
    });

    it("handles multiple parts in a single candidate", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "Here is your image" }, { inlineData: { mimeType: "image/png", data: "base64_data" } }],
            },
          },
        ],
      };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateImage({ prompt: "banana with text" });

      // Only the inlineData part should be collected, not the text part
      expect(result.result.images).toEqual(["base64_data"]);
    });

    it("throws when no images returned (safety filter)", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "I cannot generate that image." }],
            },
          },
        ],
      };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateImage({ prompt: "blocked content" })).rejects.toThrow(
        "Nano Banana returned no images",
      );
    });

    it("throws when candidates array is empty", async () => {
      const response = { candidates: [] };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateImage({ prompt: "empty" })).rejects.toThrow("Nano Banana returned no images");
    });

    it("throws when candidates is missing", async () => {
      const response = {};
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateImage({ prompt: "missing" })).rejects.toThrow("Nano Banana returned no images");
    });

    it("throws on API error with message", async () => {
      const errorBody = { error: { message: "API key not valid", status: "INVALID_ARGUMENT" } };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(errorBody, 400));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateImage({ prompt: "test" })).rejects.toThrow("Nano Banana API error (400)");
    });

    it("throws on 429 rate limit with retry-after", async () => {
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ error: "quota exceeded" }, 429, { "retry-after": "30" }));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      try {
        await adapter.generateImage({ prompt: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter: string };
        expect(error.message).toBe("Nano Banana rate limit exceeded");
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBe("30");
      }
    });

    it("handles 429 without retry-after header", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "quota exceeded" }, 429));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      try {
        await adapter.generateImage({ prompt: "test" });
        expect.fail("should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { httpStatus: number; retryAfter?: string };
        expect(error.httpStatus).toBe(429);
        expect(error.retryAfter).toBeUndefined();
      }
    });

    it("throws on 500 server error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ error: "Internal error" }, 500));

      const adapter = createNanoBananaAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateImage({ prompt: "test" })).rejects.toThrow("Nano Banana API error (500)");
    });

    it("uses custom baseUrl", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter(makeConfig({ baseUrl: "https://custom.googleapis.com" }), fetchFn);
      await adapter.generateImage({ prompt: "test" });

      const url = fetchFn.mock.calls[0][0] as string;
      expect(url).toContain("https://custom.googleapis.com/v1beta/models/");
    });

    it("uses default costPerImage when not configured", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter({ apiKey: "key" }, fetchFn);
      const result = await adapter.generateImage({ prompt: "test" });

      // Default cost: 1 * $0.02 = $0.02
      expect(result.cost).toBe(0.02);
    });

    it("uses default marginMultiplier when not configured", async () => {
      const response = imageResponse();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(response));

      const adapter = createNanoBananaAdapter({ apiKey: "key" }, fetchFn);
      const result = await adapter.generateImage({ prompt: "test" });

      expect(result.charge).toBeCloseTo(withMargin(0.02, 1.3), 6);
    });
  });
});
