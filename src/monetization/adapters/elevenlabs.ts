/**
 * ElevenLabs hosted adapter -- TTS with per-character billing.
 *
 * ElevenLabs provides premium text-to-speech synthesis. This adapter wraps
 * their API behind the standard ProviderAdapter interface with per-character
 * cost tracking and margin billing.
 *
 * Cost is calculated from character count (input text length) at the
 * configured wholesale rate, with margin applied via withMargin().
 */

import type { AdapterResult, ProviderAdapter, TTSInput, TTSOutput } from "./types.js";
import { withMargin } from "./types.js";

/** Configuration for the ElevenLabs adapter */
export interface ElevenLabsAdapterConfig {
  /** ElevenLabs API key (WOPR's pooled wholesale key) */
  apiKey: string;
  /** API base URL (default: https://api.elevenlabs.io) */
  baseUrl?: string;
  /** Default voice ID */
  defaultVoice?: string;
  /** Default model (eleven_multilingual_v2, eleven_turbo_v2_5, etc.) */
  defaultModel?: string;
  /** Cost per character in USD (wholesale) */
  costPerChar?: number;
  /** Margin multiplier (default: 1.3) */
  marginMultiplier?: number;
}

/**
 * A function that performs an HTTP fetch. Accepts the same signature as
 * the global `fetch`. This indirection lets tests inject a stub without
 * mocking globals.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // "Rachel" -- ElevenLabs default
const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_COST_PER_CHAR = 0.000015; // ~$15 per 1M chars (enterprise tier)
const DEFAULT_MARGIN = 1.3;

/**
 * Create an ElevenLabs provider adapter.
 *
 * Uses factory function pattern (not class) to keep the API surface minimal
 * and to allow easy dependency injection of fetch for testing.
 */
export function createElevenLabsAdapter(
  config: ElevenLabsAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "synthesizeSpeech">> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const defaultVoice = config.defaultVoice ?? DEFAULT_VOICE;
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const costPerChar = config.costPerChar ?? DEFAULT_COST_PER_CHAR;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;

  return {
    name: "elevenlabs",
    capabilities: ["tts"] as const,

    async synthesizeSpeech(input: TTSInput): Promise<AdapterResult<TTSOutput>> {
      const voice = input.voice ?? defaultVoice;
      const format = input.format ?? "mp3_44100_128";

      const body: Record<string, unknown> = {
        text: input.text,
        model_id: defaultModel,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      };

      const res = await fetchFn(`${baseUrl}/v1/text-to-speech/${voice}?output_format=${format}`, {
        method: "POST",
        headers: {
          "xi-api-key": config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ElevenLabs API error (${res.status}): ${text}`);
      }

      // ElevenLabs returns raw audio bytes. The content-type header tells us the format.
      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);

      // Estimate duration from character count (rough: ~15 chars/sec for speech)
      const characterCount = input.text.length;
      const durationSeconds = characterCount / 15;

      // Cost is per-character
      const cost = characterCount * costPerChar;
      const charge = withMargin(cost, marginMultiplier);

      return {
        result: {
          audioUrl,
          durationSeconds,
          format: format.split("_")[0] ?? "mp3",
          characterCount,
        },
        cost,
        charge,
      };
    },
  };
}
