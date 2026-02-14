import { describe, expect, it, vi } from "vitest";
import type { FetchFn, ReplicateAdapterConfig } from "./replicate.js";
import { createReplicateAdapter } from "./replicate.js";
import { withMargin } from "./types.js";

/** Helper to create a mock Response */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

/** A completed Replicate prediction with metrics */
function succeededPrediction(overrides: Record<string, unknown> = {}) {
  return {
    id: "pred_abc123",
    status: "succeeded",
    output: {
      text: "Hello world, this is a test transcription.",
      detected_language: "en",
      segments: [],
    },
    metrics: {
      predict_time: 4.2, // 4.2 seconds of GPU time
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ReplicateAdapterConfig> = {}): ReplicateAdapterConfig {
  return {
    apiToken: "r8_test_token",
    baseUrl: "https://api.replicate.com",
    costPerSecond: 0.000225,
    marginMultiplier: 1.3,
    maxPollAttempts: 3,
    pollIntervalMs: 1, // 1ms for fast tests
    ...overrides,
  };
}

describe("createReplicateAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockResponse({}));
    const adapter = createReplicateAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("replicate");
    expect(adapter.capabilities).toEqual(["transcription", "image-generation", "text-generation"]);
  });

  describe("transcribe", () => {
    it("creates prediction and returns result with cost (sync Prefer: wait)", async () => {
      const prediction = succeededPrediction();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      // Verify the API was called correctly
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.replicate.com/v1/predictions");
      expect(init?.method).toBe("POST");

      const body = JSON.parse(init?.body as string);
      expect(body.input.audio).toBe("https://example.com/audio.mp3");
      expect(body.version).toBeDefined();

      // Verify headers include auth and Prefer: wait
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer r8_test_token");
      expect(headers.Prefer).toBe("wait");

      // Verify result
      expect(result.result.text).toBe("Hello world, this is a test transcription.");
      expect(result.result.detectedLanguage).toBe("en");
      // No segments with end times in default prediction, so durationSeconds = 0
      expect(result.result.durationSeconds).toBe(0);

      // Verify cost: 4.2 seconds * $0.000225/sec = $0.000945
      expect(result.cost).toBeCloseTo(0.000945, 6);
      // Verify charge is returned (cost * 1.3 margin)
      expect(result.charge).toBeCloseTo(0.001229, 4);
    });

    it("polls when prediction is not immediately complete", async () => {
      const pendingPrediction = { id: "pred_abc123", status: "processing" };
      const completedPrediction = succeededPrediction();

      const fetchFn = vi
        .fn<FetchFn>()
        // First call: create prediction (returns processing)
        .mockResolvedValueOnce(mockResponse(pendingPrediction))
        // Second call: poll (still processing)
        .mockResolvedValueOnce(mockResponse(pendingPrediction))
        // Third call: poll (succeeded)
        .mockResolvedValueOnce(mockResponse(completedPrediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(result.result.text).toBe("Hello world, this is a test transcription.");
      expect(result.cost).toBeCloseTo(0.000945, 6);
    });

    it("passes language hint to Replicate input", async () => {
      const prediction = succeededPrediction();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3", language: "fr" });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.input.language).toBe("fr");
    });

    it("handles string output format", async () => {
      const prediction = succeededPrediction({ output: "Plain text output" });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(result.result.text).toBe("Plain text output");
      expect(result.result.detectedLanguage).toBe("en");
    });

    it("handles string output with language hint", async () => {
      const prediction = succeededPrediction({ output: "Bonjour le monde" });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3", language: "fr" });

      expect(result.result.text).toBe("Bonjour le monde");
      expect(result.result.detectedLanguage).toBe("fr");
    });

    it("throws on API error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ detail: "Unauthorized" }, 401));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" })).rejects.toThrow(
        "Replicate API error (401)",
      );
    });

    it("throws on failed prediction", async () => {
      const failedPrediction = {
        id: "pred_abc123",
        status: "failed",
        error: "Model crashed",
      };
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ ...failedPrediction, status: "processing" }))
        .mockResolvedValueOnce(mockResponse(failedPrediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" })).rejects.toThrow(
        "Replicate prediction failed: Model crashed",
      );
    });

    it("throws on canceled prediction", async () => {
      const canceledPrediction = { id: "pred_abc123", status: "canceled" };
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ ...canceledPrediction, status: "processing" }))
        .mockResolvedValueOnce(mockResponse(canceledPrediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" })).rejects.toThrow(
        "Replicate prediction was canceled",
      );
    });

    it("throws on poll timeout", async () => {
      const processing = { id: "pred_abc123", status: "processing" };
      const fetchFn = vi.fn<FetchFn>().mockResolvedValue(mockResponse(processing));

      const adapter = createReplicateAdapter(makeConfig({ maxPollAttempts: 2 }), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" })).rejects.toThrow(
        "Replicate prediction timed out after 2 poll attempts",
      );
    });

    it("returns zero cost when predict_time is missing", async () => {
      const prediction = succeededPrediction({ metrics: {} });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(result.cost).toBe(0);
    });

    it("returns zero cost when metrics are missing entirely", async () => {
      const prediction = succeededPrediction({ metrics: undefined });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(result.cost).toBe(0);
    });

    it("throws on unexpected output format", async () => {
      const prediction = succeededPrediction({ output: null });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" })).rejects.toThrow(
        "Unexpected Replicate output format",
      );
    });
  });

  describe("charge in result", () => {
    it("returns charge (cost + margin) in the result", async () => {
      const prediction = succeededPrediction();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(result.cost).toBeCloseTo(0.000945, 6);
      // charge = cost * 1.3 margin
      expect(result.charge).toBeCloseTo(0.001229, 4);
    });
  });

  describe("durationSeconds from segments", () => {
    it("derives audio duration from last segment end time", async () => {
      const prediction = succeededPrediction({
        output: {
          text: "Hello world",
          detected_language: "en",
          segments: [{ end: 5.0 }, { end: 12.5 }],
        },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(result.result.durationSeconds).toBe(12.5);
    });

    it("returns 0 when segments array is empty", async () => {
      const prediction = succeededPrediction({
        output: { text: "Hello", detected_language: "en", segments: [] },
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(result.result.durationSeconds).toBe(0);
    });

    it("returns 0 for string output format", async () => {
      const prediction = succeededPrediction({ output: "Plain text" });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" });

      expect(result.result.durationSeconds).toBe(0);
    });
  });

  describe("error messages", () => {
    it("includes fallback when prediction.error is undefined", async () => {
      const failedPrediction = { id: "pred_abc123", status: "failed" };
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse({ ...failedPrediction, status: "processing" }))
        .mockResolvedValueOnce(mockResponse(failedPrediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/audio.mp3" })).rejects.toThrow(
        "Replicate prediction failed: unknown error",
      );
    });
  });

  describe("generateImage", () => {
    function imageSucceeded(overrides: Record<string, unknown> = {}) {
      return {
        id: "pred_img123",
        status: "succeeded",
        output: ["https://replicate.delivery/img1.png"],
        metrics: { predict_time: 8.5 },
        ...overrides,
      };
    }

    it("creates prediction and returns image URLs with cost", async () => {
      const prediction = imageSucceeded();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig({ imageCostPerSecond: 0.0023 }), fetchFn);
      const result = await adapter.generateImage({ prompt: "a cat in space" });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.replicate.com/v1/predictions");
      const body = JSON.parse(init?.body as string);
      expect(body.input.prompt).toBe("a cat in space");

      expect(result.result.images).toEqual(["https://replicate.delivery/img1.png"]);
      expect(result.result.model).toBe("sdxl");

      // Cost: 8.5s * $0.0023/s = $0.01955
      expect(result.cost).toBeCloseTo(0.01955, 5);
      expect(result.charge).toBeCloseTo(withMargin(0.01955, 1.3), 5);
    });

    it("passes optional image parameters", async () => {
      const prediction = imageSucceeded();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await adapter.generateImage({
        prompt: "a dog",
        negativePrompt: "blurry",
        width: 1024,
        height: 768,
        count: 2,
      });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.input.prompt).toBe("a dog");
      expect(body.input.negative_prompt).toBe("blurry");
      expect(body.input.width).toBe(1024);
      expect(body.input.height).toBe(768);
      expect(body.input.num_outputs).toBe(2);
    });

    it("does not send num_outputs when count is 1", async () => {
      const prediction = imageSucceeded();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await adapter.generateImage({ prompt: "a bird", count: 1 });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.input.num_outputs).toBeUndefined();
    });

    it("handles multiple image URLs in output", async () => {
      const prediction = imageSucceeded({
        output: ["https://replicate.delivery/img1.png", "https://replicate.delivery/img2.png"],
      });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateImage({ prompt: "cats" });

      expect(result.result.images).toEqual([
        "https://replicate.delivery/img1.png",
        "https://replicate.delivery/img2.png",
      ]);
    });

    it("handles single string output", async () => {
      const prediction = imageSucceeded({ output: "https://replicate.delivery/single.png" });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateImage({ prompt: "a fish" });

      expect(result.result.images).toEqual(["https://replicate.delivery/single.png"]);
    });

    it("throws on unexpected output format", async () => {
      const prediction = imageSucceeded({ output: null });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateImage({ prompt: "fail" })).rejects.toThrow(
        "Unexpected Replicate image output format",
      );
    });

    it("polls when prediction is not immediately complete", async () => {
      const pending = { id: "pred_img123", status: "processing" };
      const completed = imageSucceeded();

      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(pending))
        .mockResolvedValueOnce(mockResponse(completed));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateImage({ prompt: "async image" });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result.result.images).toEqual(["https://replicate.delivery/img1.png"]);
    });

    it("throws on API error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ detail: "Bad Request" }, 400));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateImage({ prompt: "fail" })).rejects.toThrow("Replicate API error (400)");
    });
  });

  describe("generateText", () => {
    function textSucceeded(overrides: Record<string, unknown> = {}) {
      return {
        id: "pred_txt123",
        status: "succeeded",
        output: ["Hello", ", ", "world", "!"],
        metrics: {
          predict_time: 2.1,
          input_token_count: 10,
          output_token_count: 50,
        },
        ...overrides,
      };
    }

    it("creates prediction and returns text with token-based cost", async () => {
      const prediction = textSucceeded();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(
        makeConfig({ textInputTokenCost: 0.00000065, textOutputTokenCost: 0.00000275 }),
        fetchFn,
      );
      const result = await adapter.generateText({ prompt: "Hello world" });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.replicate.com/v1/predictions");
      const body = JSON.parse(init?.body as string);
      expect(body.input.prompt).toBe("Hello world");

      expect(result.result.text).toBe("Hello, world!");
      expect(result.result.model).toBe("llama");
      expect(result.result.usage.inputTokens).toBe(10);
      expect(result.result.usage.outputTokens).toBe(50);

      // Cost: 10 * $0.00000065 + 50 * $0.00000275 = $0.0000065 + $0.0001375 = $0.000144
      expect(result.cost).toBeCloseTo(0.000144, 6);
      expect(result.charge).toBeCloseTo(withMargin(0.000144, 1.3), 6);
    });

    it("passes optional text parameters", async () => {
      const prediction = textSucceeded();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await adapter.generateText({
        prompt: "Explain quantum computing",
        maxTokens: 500,
        temperature: 0.7,
      });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.input.prompt).toBe("Explain quantum computing");
      expect(body.input.max_new_tokens).toBe(500);
      expect(body.input.temperature).toBe(0.7);
    });

    it("passes temperature=0 correctly", async () => {
      const prediction = textSucceeded();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await adapter.generateText({ prompt: "test", temperature: 0 });

      const body = JSON.parse(fetchFn.mock.calls[0][1]?.body as string);
      expect(body.input.temperature).toBe(0);
    });

    it("uses custom model name when provided", async () => {
      const prediction = textSucceeded();
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test", model: "mistral" });

      expect(result.result.model).toBe("mistral");
    });

    it("handles single string output", async () => {
      const prediction = textSucceeded({ output: "Complete text response" });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.result.text).toBe("Complete text response");
    });

    it("returns zero cost when token counts are missing", async () => {
      const prediction = textSucceeded({ metrics: { predict_time: 1.0 } });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.cost).toBe(0);
      expect(result.result.usage.inputTokens).toBe(0);
      expect(result.result.usage.outputTokens).toBe(0);
    });

    it("returns zero cost when metrics are missing entirely", async () => {
      const prediction = textSucceeded({ metrics: undefined });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "test" });

      expect(result.cost).toBe(0);
    });

    it("throws on unexpected output format", async () => {
      const prediction = textSucceeded({ output: null });
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse(prediction));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "fail" })).rejects.toThrow("Unexpected Replicate text output format");
    });

    it("polls when prediction is not immediately complete", async () => {
      const pending = { id: "pred_txt123", status: "processing" };
      const completed = textSucceeded();

      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(pending))
        .mockResolvedValueOnce(mockResponse(completed));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      const result = await adapter.generateText({ prompt: "async text" });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result.result.text).toBe("Hello, world!");
    });

    it("throws on API error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse({ detail: "Forbidden" }, 403));

      const adapter = createReplicateAdapter(makeConfig(), fetchFn);
      await expect(adapter.generateText({ prompt: "fail" })).rejects.toThrow("Replicate API error (403)");
    });
  });
});

describe("withMargin", () => {
  it("applies default 30% margin", () => {
    expect(withMargin(1.0)).toBeCloseTo(1.3, 6);
  });

  it("applies custom margin multiplier", () => {
    expect(withMargin(1.0, 1.5)).toBeCloseTo(1.5, 6);
  });

  it("handles zero cost", () => {
    expect(withMargin(0)).toBe(0);
  });

  it("handles small costs with precision", () => {
    // 0.000945 * 1.3 = 0.0012285
    const result = withMargin(0.000945, 1.3);
    expect(result).toBeCloseTo(0.001229, 6);
  });

  it("rounds to 6 decimal places", () => {
    // 0.1234567 * 1.3 = 0.16049371 → should round to 0.160494
    const result = withMargin(0.1234567, 1.3);
    expect(result).toBe(0.160494);
  });

  describe("tier-specific markup (WOP-357)", () => {
    it("applies 20% markup for free tier", () => {
      // 1.0 * 1.20 = 1.20
      expect(withMargin(1.0, 20)).toBeCloseTo(1.2, 6);
    });

    it("applies 10% markup for pro tier", () => {
      // 1.0 * 1.10 = 1.10
      expect(withMargin(1.0, 10)).toBeCloseTo(1.1, 6);
    });

    it("applies 8% markup for team tier", () => {
      // 1.0 * 1.08 = 1.08
      expect(withMargin(1.0, 8)).toBeCloseTo(1.08, 6);
    });

    it("applies 5% markup for enterprise tier", () => {
      // 1.0 * 1.05 = 1.05
      expect(withMargin(1.0, 5)).toBeCloseTo(1.05, 6);
    });

    it("handles percentage markup with real costs", () => {
      // $0.05 cost with 10% markup = $0.055
      expect(withMargin(0.05, 10)).toBeCloseTo(0.055, 6);
    });

    it("handles percentage markup with precision", () => {
      // 0.000945 * 1.20 = 0.001134
      const result = withMargin(0.000945, 20);
      expect(result).toBeCloseTo(0.001134, 6);
    });
  });
});
