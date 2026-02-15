/**
 * Chatterbox TTS self-hosted adapter -- TTS on our own GPU infrastructure.
 *
 * Points at a self-hosted Chatterbox container running on our internal network.
 * Same ProviderAdapter interface as ElevenLabs, but with:
 * - No API key required (internal container-to-container)
 * - Amortized GPU cost instead of third-party API invoicing
 * - Lower margin (cheaper for users = the standard pricing tier)
 *
 * Cost model:
 *   Wholesale cost = 0 (we own the GPU)
 *   Amortized cost = character_count * $0.000002 (GPU depreciation + electricity)
 *   Charge = amortized_cost * margin (e.g., 1.2 = 20% margin vs 50% for third-party)
 */

import type { FetchFn, SelfHostedAdapterConfig } from "./self-hosted-base.js";
import type { AdapterResult, ProviderAdapter, TTSInput, TTSOutput } from "./types.js";
import { withMargin } from "./types.js";

// Re-export FetchFn for tests
export type { FetchFn };

/** Configuration for the Chatterbox TTS adapter */
export interface ChatterboxTTSAdapterConfig extends SelfHostedAdapterConfig {
  /** Cost per character in USD (amortized GPU time, default: $0.000002) */
  costPerChar?: number;
  /** Default voice preset */
  defaultVoice?: string;
  /** Default audio format */
  defaultFormat?: string;
}

const DEFAULT_COST_PER_CHAR = 0.000002; // ~7x cheaper than ElevenLabs wholesale
const DEFAULT_MARGIN = 1.2; // 20% vs 30-50% for third-party
const DEFAULT_VOICE = "default";
const DEFAULT_FORMAT = "wav";

/**
 * Create a Chatterbox TTS self-hosted adapter.
 *
 * Uses factory function pattern (not class) for minimal API surface and easy
 * dependency injection of fetch for testing.
 */
export function createChatterboxTTSAdapter(
  config: ChatterboxTTSAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "synthesizeSpeech">> {
  // Support both costPerChar and costPerUnit (SelfHostedAdapterConfig requires costPerUnit)
  const costPerChar = config.costPerChar ?? config.costPerUnit ?? DEFAULT_COST_PER_CHAR;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;
  const defaultVoice = config.defaultVoice ?? DEFAULT_VOICE;
  const defaultFormat = config.defaultFormat ?? DEFAULT_FORMAT;
  const timeoutMs = config.timeoutMs ?? 30000;

  return {
    name: "chatterbox-tts",
    capabilities: ["tts"] as const,
    selfHosted: true,

    async synthesizeSpeech(input: TTSInput): Promise<AdapterResult<TTSOutput>> {
      const voice = input.voice ?? defaultVoice;
      const format = input.format ?? defaultFormat;

      const body = {
        text: input.text,
        voice,
        format,
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      };

      const res = await fetchFn(`${config.baseUrl}/v1/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Chatterbox TTS error (${res.status}): ${text}`);
      }

      // Parse response - Chatterbox returns JSON with audio as base64 data URL
      const responseData = (await res.json()) as {
        audioUrl: string;
        durationSeconds: number;
        format: string;
      };

      const characterCount = Array.from(input.text).length;

      // Cost is amortized GPU time per character
      const cost = characterCount * costPerChar;
      const charge = withMargin(cost, marginMultiplier);

      return {
        result: {
          audioUrl: responseData.audioUrl,
          durationSeconds: responseData.durationSeconds,
          format: responseData.format,
          characterCount,
        },
        cost,
        charge,
      };
    },
  };
}
