import { describe, expect, it, vi } from "vitest";
import type { ChatterboxTTSAdapterConfig, FetchFn } from "./chatterbox-tts.js";
import { createChatterboxTTSAdapter } from "./chatterbox-tts.js";
import { withMargin } from "./types.js";

/** Helper to create a mock Response for Chatterbox TTS success */
function mockChatterboxResponse(status = 200): Response {
  const mockData = {
    audioUrl: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA",
    durationSeconds: 2.5,
    format: "wav",
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(mockData),
    text: () => Promise.resolve(JSON.stringify(mockData)),
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
    json: () => Promise.reject(new Error("Not JSON")),
    text: () => Promise.resolve(body),
    headers: {
      get: () => null,
    },
  } as unknown as Response;
}

function makeConfig(overrides: Partial<ChatterboxTTSAdapterConfig> = {}): ChatterboxTTSAdapterConfig {
  return {
    baseUrl: "http://chatterbox:8000",
    costPerUnit: 0.000002,
    costPerChar: 0.000002,
    marginMultiplier: 1.2,
    ...overrides,
  };
}

describe("createChatterboxTTSAdapter", () => {
  it("returns adapter with correct name and capabilities", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockChatterboxResponse());
    const adapter = createChatterboxTTSAdapter(makeConfig(), fetchFn);
    expect(adapter.name).toBe("chatterbox-tts");
    expect(adapter.capabilities).toEqual(["tts"]);
  });

  it("marks adapter as self-hosted", () => {
    const fetchFn: FetchFn = () => Promise.resolve(mockChatterboxResponse());
    const adapter = createChatterboxTTSAdapter(makeConfig(), fetchFn);
    expect(adapter.selfHosted).toBe(true);
  });

  describe("synthesizeSpeech", () => {
    it("calculates cost from character count with amortized GPU rate", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig({ costPerChar: 0.000002 }), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: "Hello world" }); // 11 chars

      const expectedCost = 11 * 0.000002;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.result.characterCount).toBe(11);
    });

    it("applies lower margin for self-hosted adapters", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig({ marginMultiplier: 1.2 }), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: "Hello world" }); // 11 chars

      const expectedCost = 11 * 0.000002;
      expect(result.cost).toBeCloseTo(expectedCost, 6);
      expect(result.charge).toBeCloseTo(withMargin(expectedCost, 1.2), 6);
    });

    it("uses voice override from input", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig({ defaultVoice: "default-voice" }), fetchFn);
      await adapter.synthesizeSpeech({ text: "test", voice: "custom-voice" });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.voice).toBe("custom-voice");
    });

    it("uses default voice when none specified in input", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig({ defaultVoice: "my-default-voice" }), fetchFn);
      await adapter.synthesizeSpeech({ text: "test" });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.voice).toBe("my-default-voice");
    });

    it("includes speed parameter when provided", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig(), fetchFn);
      await adapter.synthesizeSpeech({ text: "test", speed: 1.5 });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.speed).toBe(1.5);
    });

    it("throws on API error", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockErrorResponse(500, "Internal error"));

      const adapter = createChatterboxTTSAdapter(makeConfig(), fetchFn);
      await expect(adapter.synthesizeSpeech({ text: "test" })).rejects.toThrow(
        "Chatterbox TTS error (500): Internal error",
      );
    });

    it("posts to correct endpoint", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig({ baseUrl: "http://chatterbox:8000" }), fetchFn);
      await adapter.synthesizeSpeech({ text: "test" });

      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe("http://chatterbox:8000/v1/tts");
    });

    it("returns audio data URL from response", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig(), fetchFn);
      const result = await adapter.synthesizeSpeech({ text: "test" });

      expect(result.result.audioUrl).toBe("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA");
      expect(result.result.durationSeconds).toBe(2.5);
      expect(result.result.format).toBe("wav");
    });

    it("no API key sent for self-hosted adapter", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const adapter = createChatterboxTTSAdapter(makeConfig(), fetchFn);
      await adapter.synthesizeSpeech({ text: "test" });

      const [, init] = fetchFn.mock.calls[0];
      const headers = init?.headers as Record<string, string>;
      expect(headers).not.toHaveProperty("xi-api-key");
      expect(headers).not.toHaveProperty("Authorization");
    });

    it("cost is significantly lower than third-party adapters", async () => {
      const fetchFn = vi.fn<FetchFn>().mockResolvedValueOnce(mockChatterboxResponse());

      const chatterbox = createChatterboxTTSAdapter(makeConfig({ costPerChar: 0.000002 }), fetchFn);
      const result = await chatterbox.synthesizeSpeech({ text: "x".repeat(1000) }); // 1000 chars

      // Chatterbox cost: $0.002 per 1M chars = $0.000002 per char
      // ElevenLabs cost: $15 per 1M chars = $0.000015 per char
      // Chatterbox should be ~7x cheaper
      expect(result.cost).toBeCloseTo(0.002, 6); // 1000 * 0.000002
    });
  });
});
