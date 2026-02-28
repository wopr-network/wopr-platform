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

import { Credit } from "../credit.js";
import type {
  AdapterResult,
  ImageGenerationInput,
  ImageGenerationOutput,
  ProviderAdapter,
  TextGenerationInput,
  TextGenerationOutput,
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
  /** SDXL model version on Replicate */
  imageModelVersion?: string;
  /** Cost per GPU second for image generation */
  imageCostPerSecond?: number;
  /** Llama model version on Replicate */
  textModelVersion?: string;
  /** Cost per input token for text generation */
  textInputTokenCost?: number;
  /** Cost per output token for text generation */
  textOutputTokenCost?: number;
  /** Max poll attempts when waiting for prediction (default: 60) */
  maxPollAttempts?: number;
  /** Poll interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;
}

const DEFAULT_BASE_URL = "https://api.replicate.com";
const DEFAULT_COST_PER_SECOND = 0.000225; // Whisper large-v3 on Replicate
const DEFAULT_MARGIN = 1.3;
const DEFAULT_WHISPER_VERSION = "cdd97b257f93cb89dede1c7b1be00e6ed895be431c2e8a9877826e5d7999875b";
const DEFAULT_IMAGE_MODEL_VERSION = "7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc"; // SDXL
const DEFAULT_IMAGE_COST_PER_SECOND = 0.0023; // SDXL on Replicate (A40 GPU)
const DEFAULT_TEXT_MODEL_VERSION = "2c1608e18606fad2812020dc541930f2d0495ce32eee50182cc5642f4243027"; // Llama 2 70b
const DEFAULT_TEXT_INPUT_TOKEN_COST = 0.00000065; // $0.65 per 1M input tokens
const DEFAULT_TEXT_OUTPUT_TOKEN_COST = 0.00000275; // $2.75 per 1M output tokens
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
export function createReplicateAdapter(
  config: ReplicateAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "transcribe" | "generateImage" | "generateText">> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const costPerSecond = config.costPerSecond ?? DEFAULT_COST_PER_SECOND;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;
  const whisperVersion = config.whisperVersion ?? DEFAULT_WHISPER_VERSION;
  const imageModelVersion = config.imageModelVersion ?? DEFAULT_IMAGE_MODEL_VERSION;
  const imageCostPerSecond = config.imageCostPerSecond ?? DEFAULT_IMAGE_COST_PER_SECOND;
  const textModelVersion = config.textModelVersion ?? DEFAULT_TEXT_MODEL_VERSION;
  const textInputTokenCost = config.textInputTokenCost ?? DEFAULT_TEXT_INPUT_TOKEN_COST;
  const textOutputTokenCost = config.textOutputTokenCost ?? DEFAULT_TEXT_OUTPUT_TOKEN_COST;
  const maxPollAttempts = config.maxPollAttempts ?? DEFAULT_MAX_POLL;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;

  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
    Prefer: "wait",
  };

  async function createPrediction(version: string, input: Record<string, unknown>): Promise<ReplicatePrediction> {
    const res = await fetchFn(`${baseUrl}/v1/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version, input }),
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
      if (prediction.status === "failed")
        throw new Error(`Replicate prediction failed: ${prediction.error ?? "unknown error"}`);
      if (prediction.status === "canceled") throw new Error("Replicate prediction was canceled");

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Replicate prediction timed out after ${maxPollAttempts} poll attempts`);
  }

  function extractCost(prediction: ReplicatePrediction, perSecondRate = costPerSecond): Credit {
    const predictTime = prediction.metrics?.predict_time ?? 0;
    return Credit.fromDollars(predictTime * perSecondRate);
  }

  return {
    name: "replicate",
    capabilities: ["transcription", "image-generation", "text-generation"] as const,

    async transcribe(input: TranscriptionInput): Promise<AdapterResult<TranscriptionOutput>> {
      // Create prediction using Whisper model
      let prediction = await createPrediction(whisperVersion, {
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
        durationSeconds = 0;
      } else if (output && typeof output === "object") {
        text = output.text ?? "";
        detectedLanguage = output.detected_language ?? input.language ?? "en";
        // Derive audio duration from the last segment's end time when available.
        // predict_time is GPU compute time, not audio duration.
        const segments = output.segments as Array<{ end?: number }> | undefined;
        const lastEnd = segments?.length ? segments[segments.length - 1]?.end : undefined;
        durationSeconds = lastEnd ?? 0;
      } else {
        throw new Error("Unexpected Replicate output format");
      }

      // Metering is the socket layer's responsibility — it has the tenantId.
      // The adapter returns cost + charge so the caller can emit the event.
      return {
        result: { text, detectedLanguage, durationSeconds },
        cost,
        charge,
      };
    },

    async generateImage(input: ImageGenerationInput): Promise<AdapterResult<ImageGenerationOutput>> {
      let prediction = await createPrediction(imageModelVersion, {
        prompt: input.prompt,
        ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        ...(input.count && input.count > 1 ? { num_outputs: input.count } : {}),
      });

      if (prediction.status !== "succeeded") {
        prediction = await waitForPrediction(prediction.id);
      }

      const cost = extractCost(prediction, imageCostPerSecond);
      const charge = withMargin(cost, marginMultiplier);

      // Replicate image models return an array of URLs
      const output = prediction.output;
      let images: string[];
      if (Array.isArray(output)) {
        images = output as string[];
      } else if (typeof output === "string") {
        images = [output];
      } else {
        throw new Error("Unexpected Replicate image output format");
      }

      return {
        result: { images, model: "sdxl" },
        cost,
        charge,
      };
    },

    async generateText(input: TextGenerationInput): Promise<AdapterResult<TextGenerationOutput>> {
      // Replicate models use a raw text prompt. When the full conversation
      // history is provided via `messages`, serialize it to a text prompt so
      // prior turns aren't silently discarded.
      const prompt = input.messages ? input.messages.map((m) => `${m.role}: ${m.content}`).join("\n") : input.prompt;
      let prediction = await createPrediction(textModelVersion, {
        prompt,
        ...(input.maxTokens ? { max_new_tokens: input.maxTokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      });

      if (prediction.status !== "succeeded") {
        prediction = await waitForPrediction(prediction.id);
      }

      // Replicate text models return an array of string tokens or a single string
      const output = prediction.output;
      let text: string;
      if (Array.isArray(output)) {
        text = (output as string[]).join("");
      } else if (typeof output === "string") {
        text = output;
      } else {
        throw new Error("Unexpected Replicate text output format");
      }

      // Token-based cost: Replicate provides token counts in metrics
      const metrics = prediction.metrics as
        | {
            predict_time?: number;
            input_token_count?: number;
            output_token_count?: number;
          }
        | undefined;
      const inputTokens = metrics?.input_token_count ?? 0;
      const outputTokens = metrics?.output_token_count ?? 0;
      const cost = Credit.fromDollars(inputTokens * textInputTokenCost + outputTokens * textOutputTokenCost);
      const charge = withMargin(cost, marginMultiplier);

      return {
        result: {
          text,
          model: input.model ?? "llama",
          usage: { inputTokens, outputTokens },
        },
        cost,
        charge,
      };
    },
  };
}
