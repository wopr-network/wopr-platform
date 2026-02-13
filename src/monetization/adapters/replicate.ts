/**
 * Replicate hosted adapter — first wholesale provider adapter.
 *
 * Proves the socket/adapter/margin pattern end-to-end. Replicate is chosen
 * because it has the broadest model coverage (voice, image, embeddings, LLM)
 * behind a single API.
 *
 * This is proprietary — plugin authors and users never see it. They see
 * "WOPR Hosted" and this adapter is the invisible layer.
 */

import type {
  AdapterCapability,
  AdapterResult,
  MeterEvent,
  ProviderAdapter,
  TranscriptionInput,
  TranscriptionOutput,
} from "./types.js";
import { withMargin } from "./types.js";

/** Replicate prediction status */
type PredictionStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

/** Shape of a Replicate prediction response (subset we care about) */
interface ReplicatePrediction {
  id: string;
  status: PredictionStatus;
  output: unknown;
  metrics?: {
    predict_time?: number;
  };
  error?: string;
}

/** Configuration for the Replicate adapter */
export interface ReplicateAdapterConfig {
  /** Replicate API token (wholesale credentials) */
  apiToken: string;
  /** Base URL for the Replicate API (default: https://api.replicate.com) */
  baseUrl?: string;
  /** Cost per second of predict_time in USD (Replicate's rate for Whisper) */
  costPerSecond?: number;
  /** Margin multiplier applied to wholesale cost (default: 1.3 = 30%) */
  marginMultiplier?: number;
  /** Whisper model version on Replicate */
  whisperVersion?: string;
  /** Max poll attempts when waiting for prediction (default: 60) */
  maxPollAttempts?: number;
  /** Poll interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;
  /** Callback for meter events (fire-and-forget to metering layer) */
  onMeterEvent?: (event: MeterEvent) => void;
}

const DEFAULT_BASE_URL = "https://api.replicate.com";
const DEFAULT_COST_PER_SECOND = 0.000225; // Whisper large-v3 on Replicate
const DEFAULT_MARGIN = 1.3;
const DEFAULT_WHISPER_VERSION = "cdd97b257f93cb89dede1c7b1be00e6ed895be431c2e8a9877826e5d7999875b";
const DEFAULT_MAX_POLL = 60;
const DEFAULT_POLL_INTERVAL = 1000;

/**
 * A function that performs an HTTP fetch. Accepts the same signature as
 * the global `fetch`. This indirection lets tests inject a stub without
 * mocking globals.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Create a Replicate provider adapter.
 *
 * Uses factory function pattern (not class) to keep the API surface minimal
 * and to allow easy dependency injection of fetch for testing.
 */
export function createReplicateAdapter(config: ReplicateAdapterConfig, fetchFn: FetchFn = fetch): ProviderAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const costPerSecond = config.costPerSecond ?? DEFAULT_COST_PER_SECOND;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;
  const whisperVersion = config.whisperVersion ?? DEFAULT_WHISPER_VERSION;
  const maxPollAttempts = config.maxPollAttempts ?? DEFAULT_MAX_POLL;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;

  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
    Prefer: "wait",
  };

  async function createPrediction(input: Record<string, unknown>): Promise<ReplicatePrediction> {
    const res = await fetchFn(`${baseUrl}/v1/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: whisperVersion, input }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Replicate API error (${res.status}): ${body}`);
    }

    return (await res.json()) as ReplicatePrediction;
  }

  async function getPrediction(id: string): Promise<ReplicatePrediction> {
    const res = await fetchFn(`${baseUrl}/v1/predictions/${id}`, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Replicate API error (${res.status}): ${body}`);
    }

    return (await res.json()) as ReplicatePrediction;
  }

  async function waitForPrediction(id: string): Promise<ReplicatePrediction> {
    for (let i = 0; i < maxPollAttempts; i++) {
      const prediction = await getPrediction(id);

      if (prediction.status === "succeeded") return prediction;
      if (prediction.status === "failed") throw new Error(`Replicate prediction failed: ${prediction.error}`);
      if (prediction.status === "canceled") throw new Error("Replicate prediction was canceled");

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Replicate prediction timed out after ${maxPollAttempts} poll attempts`);
  }

  function extractCost(prediction: ReplicatePrediction): number {
    const predictTime = prediction.metrics?.predict_time ?? 0;
    return predictTime * costPerSecond;
  }

  function emitMeterEvent(capability: AdapterCapability, cost: number, charge: number, tenantId: string): void {
    if (!config.onMeterEvent) return;

    const event: MeterEvent = {
      adapter: "replicate",
      capability,
      cost,
      charge,
      timestamp: new Date().toISOString(),
      tenantId,
    };

    // Fire-and-forget — metering failures must never block the response
    try {
      config.onMeterEvent(event);
    } catch {
      // Swallow — metering is best-effort
    }
  }

  return {
    name: "replicate",
    capabilities: ["transcription"] as const,

    async transcribe(input: TranscriptionInput): Promise<AdapterResult<TranscriptionOutput>> {
      // Create prediction using Whisper model
      let prediction = await createPrediction({
        audio: input.audioUrl,
        ...(input.language ? { language: input.language } : {}),
      });

      // If not immediately complete (no Prefer: wait support or async), poll
      if (prediction.status !== "succeeded") {
        prediction = await waitForPrediction(prediction.id);
      }

      // Extract cost from predict_time
      const cost = extractCost(prediction);
      const charge = withMargin(cost, marginMultiplier);

      // Parse Replicate's Whisper output
      const output = prediction.output as { text?: string; detected_language?: string; segments?: unknown[] } | string;

      let text: string;
      let detectedLanguage: string;
      let durationSeconds: number;

      if (typeof output === "string") {
        text = output;
        detectedLanguage = input.language ?? "en";
        durationSeconds = prediction.metrics?.predict_time ?? 0;
      } else if (output && typeof output === "object") {
        text = output.text ?? "";
        detectedLanguage = output.detected_language ?? input.language ?? "en";
        durationSeconds = prediction.metrics?.predict_time ?? 0;
      } else {
        throw new Error("Unexpected Replicate output format");
      }

      // Emit meter event (fire-and-forget)
      // tenantId is not available at this layer — the socket injects it
      emitMeterEvent("transcription", cost, charge, "");

      return {
        result: { text, detectedLanguage, durationSeconds },
        cost,
      };
    },
  };
}
