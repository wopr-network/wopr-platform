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
    expect(adapter.capabilities).toEqual(["transcription"]);
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
});
