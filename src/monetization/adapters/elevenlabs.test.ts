import { describe, expect, it, vi } from "vitest";
import type { ElevenLabsAdapterConfig, FetchFn } from "./elevenlabs.js";
import { createElevenLabsAdapter } from "./elevenlabs.js";
import { withMargin } from "./types.js";

/** Helper to create a mock Response for audio data */
function mockAudioResponse(status = 200): Response {
  const blob = new Blob(["fake-audio-data"], { type: "audio/mpeg" });
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: () => Promise.resolve(blob),
    text: () => Promise.resolve("fake-audio-data"),
    headers: {
      get: () => null,
    },
  } as unknown as Response;
}

/** Helper to create a mock error response */
function mockErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    blob: () => Promise.resolve(new Blob([])),
    text: () => Promise.resolve(body),
    headers: {
      get: () => null,
    },
  } as unknown as Response;
}

function makeConfig(overrides: Partial<ElevenLabsAdapterConfig> = {}): ElevenLabsAdapterConfig {
  return {
    apiKey: "xi-test-key-123",
    baseUrl: "https://api.elevenlabs.io",
    defaultVoice: "test-voice-id",
    defaultModel: "eleven_multilingual_v2",
    costPerChar: 0.000015,
    marginMultiplier: 1.3,
    ...overrides,
  };
}

describe("createElevenLabsAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockAudioResponse());
    const adapter = createElevenLabsAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("elevenlabs");
    expect(adapter.capabilities).toEqual(["tts"]);
  });

  describe("synthesizeSpeech", () => {
    it("calculates cost from character count", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig({ costPerChar: 0.000015 }), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: "Hello world" }); // 11 chars

      const expectedCost = 11 * 0.000015;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.result.characterCount).toBe(11);
    });

    it("applies margin correctly", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig({ marginMultiplier: 1.5 }), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: "Hello world" }); // 11 chars

      const expectedCost = 11 * 0.000015;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.charge).toBeCloseTo(withMargin(expectedCost, 1.5), 6);
    });

    it("uses voice override from input", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig({ defaultVoice: "default-voice" }), fetchFn);
      await adapter.synthesizeSpeech({ text: "test", voice: "custom-voice-id" });

      const [url] = fetchFn.mock.calls[0];
      expect(url).toContain("/v1/text-to-speech/custom-voice-id");
    });

    it("uses default voice when none specified in input", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig({ defaultVoice: "my-default-voice" }), fetchFn);
      await adapter.synthesizeSpeech({ text: "test" });

      const [url] = fetchFn.mock.calls[0];
      expect(url).toContain("/v1/text-to-speech/my-default-voice");
    });

    it("throws on API error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockErrorResponse(401, "Unauthorized"));

      const adapter = createElevenLabsAdapter(makeConfig(), fetchFn);
      await expect(adapter.synthesizeSpeech({ text: "test" })).rejects.toThrow(
        "ElevenLabs API error (401): Unauthorized",
      );
    });

    it("throws on 500 server error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockErrorResponse(500, "Internal server error"));

      const adapter = createElevenLabsAdapter(makeConfig(), fetchFn);
      await expect(adapter.synthesizeSpeech({ text: "test" })).rejects.toThrow("ElevenLabs API error (500)");
    });

    it("sends correct request format", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig(), fetchFn);
      await adapter.synthesizeSpeech({ text: "Hello world" });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128");
      expect(init?.method).toBe("POST");

      const headers = init?.headers as Record<string, string>;
      expect(headers["xi-api-key"]).toBe("xi-test-key-123");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init?.body as string);
      expect(body.text).toBe("Hello world");
      expect(body.model_id).toBe("eleven_multilingual_v2");
      expect(body.voice_settings).toEqual({
        stability: 0.5,
        similarity_boost: 0.75,
      });
    });

    it("uses custom baseUrl", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig({ baseUrl: "https://custom.elevenlabs.io" }), fetchFn);
      await adapter.synthesizeSpeech({ text: "test" });

      const [url] = fetchFn.mock.calls[0];
      expect(url).toContain("https://custom.elevenlabs.io/v1/text-to-speech/");
    });

    it("uses format override from input", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig(), fetchFn);
      await adapter.synthesizeSpeech({ text: "test", format: "pcm_44100" });

      const [url] = fetchFn.mock.calls[0];
      expect(url).toContain("output_format=pcm_44100");
    });

    it("returns correct format extracted from output_format string", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig(), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: "test" });

      // Default format is "mp3_44100_128", should extract "mp3"
      expect(result.result.format).toBe("mp3");
    });

    it("handles empty text with zero cost", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());

      const adapter = createElevenLabsAdapter(makeConfig(), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: "" });

      expect(result.cost).toBe(0);
      expect(result.result.characterCount).toBe(0);
    });

    it("calculates cost correctly for long text", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockAudioResponse());
      const longText = "a".repeat(1000);

      const adapter = createElevenLabsAdapter(makeConfig({ costPerChar: 0.000015 }), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: longText });

      const expectedCost = 1000 * 0.000015;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.charge).toBeCloseTo(withMargin(expectedCost, 1.3), 6);
      expect(result.result.characterCount).toBe(1000);
    });
  });
});
