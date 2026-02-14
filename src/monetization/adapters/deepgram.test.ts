import { describe, expect, it, vi } from "vitest";
import type { DeepgramAdapterConfig, FetchFn } from "./deepgram.js";
import { createDeepgramAdapter } from "./deepgram.js";
import { withMargin } from "./types.js";

/** Helper to create a mock Response */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as Response;
}

/** A successful Deepgram transcription response */
function deepgramResponse(overrides: Record<string, unknown> = {}) {
  return {
    results: {
      channels: [
        {
          alternatives: [{ transcript: "Hello world, this is a test." }],
          detected_language: "en",
        },
      ],
    },
    metadata: {
      duration: 30.5, // 30.5 seconds of audio
      ...overrides,
    },
  };
}

function makeConfig(overrides: Partial<DeepgramAdapterConfig> = {}): DeepgramAdapterConfig {
  return {
    apiKey: "dg-test-key-123",
    baseUrl: "https://api.deepgram.com",
    defaultModel: "nova-2",
    marginMultiplier: 1.3,
    ...overrides,
  };
}

describe("createDeepgramAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockResponse({}));
    const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("deepgram");
    expect(adapter.capabilities).toEqual(["transcription"]);
  });

  describe("transcribe", () => {
    it("calculates cost from audio duration", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        // First call: fetch audio from URL
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        // Second call: Deepgram API
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig({ costPerMinute: 0.0043 }), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      // 30.5 seconds = 30.5/60 minutes * $0.0043/min
      const expectedCost = (30.5 / 60) * 0.0043;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.result.durationSeconds).toBe(30.5);
    });

    it("applies margin correctly", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig({ marginMultiplier: 1.5 }), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      const expectedCost = (30.5 / 60) * 0.0043;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.charge).toBeCloseTo(withMargin(expectedCost, 1.5), 6);
    });

    it("uses default margin of 1.3", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig({ marginMultiplier: undefined }), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      const expectedCost = (30.5 / 60) * 0.0043;
      expect(result.charge).toBeCloseTo(withMargin(expectedCost, 1.3), 6);
    });

    it("sends model as query parameter", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig({ defaultModel: "nova-2-general" }), fetchFn);
      await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      // Second call is the Deepgram API call
      const [url] = fetchFn.mock.calls[1];
      expect(url).toContain("model=nova-2-general");
    });

    it("passes language hint in query params", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      await adapter.transcribe({ audioUrl: "https://example.com/audio.wav", language: "es" });

      const [url] = fetchFn.mock.calls[1];
      expect(url).toContain("language=es");
      // Should not have detect_language when language is explicitly set
      expect(url).not.toContain("detect_language");
    });

    it("enables auto language detection when no language specified", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      const [url] = fetchFn.mock.calls[1];
      expect(url).toContain("detect_language=true");
    });

    it("returns transcript text from response", async () => {
      const response = deepgramResponse();
      response.results.channels[0].alternatives[0].transcript = "The quick brown fox.";
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      expect(result.result.text).toBe("The quick brown fox.");
    });

    it("returns detected language from response", async () => {
      const response = deepgramResponse();
      response.results.channels[0].detected_language = "fr";
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      expect(result.result.detectedLanguage).toBe("fr");
    });

    it("sends Authorization header with Token prefix", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig({ apiKey: "dg-my-key" }), fetchFn);
      await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      const headers = fetchFn.mock.calls[1][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Token dg-my-key");
    });

    it("uses custom baseUrl", async () => {
      const response = deepgramResponse();
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(
        makeConfig({ baseUrl: "https://custom.deepgram.com" }),
        fetchFn,
      );
      await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      const [url] = fetchFn.mock.calls[1];
      expect(url).toContain("https://custom.deepgram.com/v1/listen");
    });

    it("throws on Deepgram API error", async () => {
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse({ err_msg: "Invalid API key" }, 401));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/audio.wav" })).rejects.toThrow(
        "Deepgram API error (401)",
      );
    });

    it("throws when audio fetch fails", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockResponse("Not Found", 404));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      await expect(adapter.transcribe({ audioUrl: "https://example.com/missing.wav" })).rejects.toThrow(
        "Failed to fetch audio (404)",
      );
    });

    it("handles empty transcript gracefully", async () => {
      const response = deepgramResponse();
      response.results.channels[0].alternatives[0].transcript = "";
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/silence.wav" });

      expect(result.result.text).toBe("");
    });

    it("falls back to 'en' when no language detected and none provided", async () => {
      const response = {
        results: {
          channels: [
            {
              alternatives: [{ transcript: "test" }],
              // no detected_language
            },
          ],
        },
        metadata: { duration: 5.0 },
      };
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      expect(result.result.detectedLanguage).toBe("en");
    });

    it("uses input language as fallback when no language detected", async () => {
      const response = {
        results: {
          channels: [
            {
              alternatives: [{ transcript: "test" }],
              // no detected_language
            },
          ],
        },
        metadata: { duration: 5.0 },
      };
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig(), fetchFn);
      const result = await adapter.transcribe({
        audioUrl: "https://example.com/audio.wav",
        language: "de",
      });

      expect(result.result.detectedLanguage).toBe("de");
    });

    it("uses custom cost per minute", async () => {
      const response = deepgramResponse({ duration: 60 }); // exactly 1 minute
      const fetchFn = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(mockResponse(new ArrayBuffer(8)))
        .mockResolvedValueOnce(mockResponse(response));

      const adapter = createDeepgramAdapter(makeConfig({ costPerMinute: 0.01 }), fetchFn);
      const result = await adapter.transcribe({ audioUrl: "https://example.com/audio.wav" });

      // 60 seconds = 1 minute * $0.01/min = $0.01
      expect(result.cost).toBeCloseTo(0.01, 6);
    });
  });
});
