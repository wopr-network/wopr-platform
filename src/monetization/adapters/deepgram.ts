/**
 * Deepgram hosted adapter — STT with per-minute billing.
 *
 * Deepgram is faster and cheaper than Replicate/Whisper for real-time
 * transcription and supports streaming (critical for live voice conversations).
 *
 * Billing is per-minute of audio, not per-second of GPU time.
 * Wholesale rate for Nova-2 is ~$0.0043/min.
 */

import type { AdapterResult, ProviderAdapter, TranscriptionInput, TranscriptionOutput } from "./types.js";
import { withMargin } from "./types.js";

/** Configuration for the Deepgram adapter */
export interface DeepgramAdapterConfig {
  /** Deepgram API key (WOPR's pooled wholesale key) */
  apiKey: string;
  /** API base URL (default: https://api.deepgram.com) */
  baseUrl?: string;
  /** Default model (nova-2, nova-2-general, etc.) */
  defaultModel?: string;
  /** Cost per minute in USD (wholesale, default: $0.0043 for Nova-2) */
  costPerMinute?: number;
  /** Margin multiplier (default: 1.3) */
  marginMultiplier?: number;
}

/**
 * A function that performs an HTTP fetch. Accepts the same signature as
 * the global `fetch`. This indirection lets tests inject a stub without
 * mocking globals.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Deepgram transcription response (subset we care about) */
interface DeepgramResponse {
  results: {
    channels: Array<{
      alternatives: Array<{
        transcript: string;
      }>;
      detected_language?: string;
    }>;
  };
  metadata: {
    duration: number;
    model_info?: Record<string, unknown>;
  };
}

const DEFAULT_BASE_URL = "https://api.deepgram.com";
const DEFAULT_MODEL = "nova-2";
const DEFAULT_COST_PER_MINUTE = 0.0043; // Nova-2 wholesale
const DEFAULT_MARGIN = 1.3;

/**
 * Create a Deepgram provider adapter.
 *
 * Uses factory function pattern (not class) to keep the API surface minimal
 * and to allow easy dependency injection of fetch for testing.
 */
export function createDeepgramAdapter(
  config: DeepgramAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "transcribe">> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const costPerMinute = config.costPerMinute ?? DEFAULT_COST_PER_MINUTE;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;

  return {
    name: "deepgram",
    capabilities: ["transcription"] as const,

    async transcribe(input: TranscriptionInput): Promise<AdapterResult<TranscriptionOutput>> {
      const model = defaultModel;

      // Build query params
      const params = new URLSearchParams({ model });
      if (input.language) {
        params.set("language", input.language);
      } else {
        // Enable auto language detection when no language hint provided
        params.set("detect_language", "true");
      }

      // Fetch the audio from the URL and send as body
      const audioRes = await fetchFn(input.audioUrl);
      if (!audioRes.ok) {
        throw new Error(`Failed to fetch audio (${audioRes.status}): ${input.audioUrl}`);
      }
      const audioBody = await audioRes.arrayBuffer();

      const res = await fetchFn(`${baseUrl}/v1/listen?${params.toString()}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${config.apiKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: audioBody,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Deepgram API error (${res.status}): ${text}`);
      }

      const data = (await res.json()) as DeepgramResponse;

      const transcript = data.results.channels[0]?.alternatives[0]?.transcript ?? "";
      const detectedLanguage = data.results.channels[0]?.detected_language ?? input.language ?? "en";
      const durationSeconds = data.metadata.duration;

      // Cost = (duration in seconds / 60) * cost per minute
      const cost = (durationSeconds / 60) * costPerMinute;
      const charge = withMargin(cost, marginMultiplier);

      return {
        result: {
          text: transcript,
          detectedLanguage,
          durationSeconds,
        },
        cost,
        charge,
      };
    },
  };
}
