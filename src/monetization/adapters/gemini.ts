/**
 * Gemini hosted adapter -- text generation via Google's Generative Language API.
 *
 * Gemini is the cheapest at-scale LLM provider, making it critical for
 * margin on high-volume text generation workloads.
 *
 * Cost is calculated from the usageMetadata returned by the Gemini API
 * (promptTokenCount + candidatesTokenCount) using configured per-model rates.
 */

import { Credit } from "../credit.js";
import type { AdapterResult, ProviderAdapter, TextGenerationInput, TextGenerationOutput } from "./types.js";
import { withMargin } from "./types.js";

/** Configuration for the Gemini adapter */
export interface GeminiAdapterConfig {
  /** Google API key (WOPR's pooled wholesale key) */
  apiKey: string;
  /** Gemini API base URL (default: https://generativelanguage.googleapis.com) */
  baseUrl?: string;
  /** Default model (default: "gemini-2.0-flash") */
  defaultModel?: string;
  /** Cost per 1M input tokens in USD (default: $0.10 for gemini-2.0-flash) */
  inputTokenCostPer1M?: number;
  /** Cost per 1M output tokens in USD (default: $0.40 for gemini-2.0-flash) */
  outputTokenCostPer1M?: number;
  /** Margin multiplier (default: 1.3) */
  marginMultiplier?: number;
}

/**
 * A function that performs an HTTP fetch. Accepts the same signature as
 * the global `fetch`. This indirection lets tests inject a stub without
 * mocking globals.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Gemini generateContent response (subset we care about) */
interface GenerateContentResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
    };
  }>;
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
  };
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.0-flash";
const DEFAULT_MARGIN = 1.3;
// Gemini 2.0 Flash pricing (as of 2025)
const DEFAULT_INPUT_COST_PER_1M = 0.1; // $0.10 per 1M input tokens
const DEFAULT_OUTPUT_COST_PER_1M = 0.4; // $0.40 per 1M output tokens

/**
 * Create a Gemini provider adapter.
 *
 * Uses factory function pattern (not class) to keep the API surface minimal
 * and to allow easy dependency injection of fetch for testing.
 */
export function createGeminiAdapter(
  config: GeminiAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "generateText">> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;
  const inputCostPer1M = config.inputTokenCostPer1M ?? DEFAULT_INPUT_COST_PER_1M;
  const outputCostPer1M = config.outputTokenCostPer1M ?? DEFAULT_OUTPUT_COST_PER_1M;

  return {
    name: "gemini",
    capabilities: ["text-generation"] as const,

    async generateText(input: TextGenerationInput): Promise<AdapterResult<TextGenerationOutput>> {
      const model = input.model ?? defaultModel;

      const body: Record<string, unknown> = {
        contents: [{ parts: [{ text: input.prompt }] }],
      };

      const generationConfig: Record<string, unknown> = {};
      if (input.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = input.maxTokens;
      }
      if (input.temperature !== undefined) {
        generationConfig.temperature = input.temperature;
      }
      if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig;
      }

      const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${config.apiKey}`;

      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const error = Object.assign(new Error("Gemini rate limit exceeded"), {
          httpStatus: 429,
          retryAfter: retryAfter ?? undefined,
        });
        throw error;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API error (${res.status}): ${text}`);
      }

      const data = (await res.json()) as GenerateContentResponse;

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

      // Cost calculation from token counts and configured rates
      const cost = Credit.fromDollars(
        (inputTokens / 1_000_000) * inputCostPer1M + (outputTokens / 1_000_000) * outputCostPer1M,
      );
      const charge = withMargin(cost, marginMultiplier);

      return {
        result: {
          text,
          model,
          usage: { inputTokens, outputTokens },
        },
        cost,
        charge,
      };
    },
  };
}
