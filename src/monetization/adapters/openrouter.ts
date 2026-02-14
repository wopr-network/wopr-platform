/**
 * OpenRouter hosted adapter — multi-provider text generation via single API.
 *
 * OpenRouter aggregates 200+ models behind a single OpenAI-compatible API.
 * One adapter = access to the entire model ecosystem (Anthropic, OpenAI,
 * Google, Meta, Mistral, etc.).
 *
 * Cost is extracted from the `x-openrouter-cost` response header (preferred),
 * falling back to token-based calculation when the header is absent.
 */

import type {
  AdapterResult,
  ProviderAdapter,
  TextGenerationInput,
  TextGenerationOutput,
} from "./types.js";
import { withMargin } from "./types.js";

/** Configuration for the OpenRouter adapter */
export interface OpenRouterAdapterConfig {
  /** OpenRouter API key */
  apiKey: string;
  /** Base URL for the OpenRouter API (default: https://openrouter.ai/api) */
  baseUrl?: string;
  /** Default model to use (default: "openai/gpt-4o-mini") */
  defaultModel?: string;
  /** Margin multiplier applied to wholesale cost (default: 1.3 = 30%) */
  marginMultiplier?: number;
  /** App URL sent as HTTP-Referer header (for OpenRouter rankings) */
  appUrl?: string;
  /** App name sent as X-Title header (for OpenRouter rankings) */
  appName?: string;
  /** Fallback cost per input token when header is missing */
  fallbackInputTokenCost?: number;
  /** Fallback cost per output token when header is missing */
  fallbackOutputTokenCost?: number;
}

/**
 * A function that performs an HTTP fetch. Accepts the same signature as
 * the global `fetch`. This indirection lets tests inject a stub without
 * mocking globals.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** OpenAI-compatible chat completion response (subset we care about) */
interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_MARGIN = 1.3;
const DEFAULT_FALLBACK_INPUT_TOKEN_COST = 0.000001; // $1.00 per 1M input tokens
const DEFAULT_FALLBACK_OUTPUT_TOKEN_COST = 0.000002; // $2.00 per 1M output tokens

/**
 * Create an OpenRouter provider adapter.
 *
 * Uses factory function pattern (not class) to keep the API surface minimal
 * and to allow easy dependency injection of fetch for testing.
 */
export function createOpenRouterAdapter(
  config: OpenRouterAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "generateText">> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;
  const fallbackInputTokenCost = config.fallbackInputTokenCost ?? DEFAULT_FALLBACK_INPUT_TOKEN_COST;
  const fallbackOutputTokenCost = config.fallbackOutputTokenCost ?? DEFAULT_FALLBACK_OUTPUT_TOKEN_COST;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
    if (config.appUrl) {
      headers["HTTP-Referer"] = config.appUrl;
    }
    if (config.appName) {
      headers["X-Title"] = config.appName;
    }
    return headers;
  }

  return {
    name: "openrouter",
    capabilities: ["text-generation"] as const,

    async generateText(input: TextGenerationInput): Promise<AdapterResult<TextGenerationOutput>> {
      const model = input.model ?? defaultModel;

      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: input.prompt }],
      };
      if (input.maxTokens !== undefined) {
        body.max_tokens = input.maxTokens;
      }
      if (input.temperature !== undefined) {
        body.temperature = input.temperature;
      }

      const res = await fetchFn(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
      });

      // Propagate 429 rate limit errors with retry-after
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const error = Object.assign(new Error("OpenRouter rate limit exceeded"), {
          httpStatus: 429,
          retryAfter: retryAfter ?? undefined,
        });
        throw error;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter API error (${res.status}): ${text}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;

      const text = data.choices[0]?.message?.content ?? "";
      const responseModel = data.model;
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;

      // Prefer cost from x-openrouter-cost header (exact provider cost in USD)
      const costHeader = res.headers.get("x-openrouter-cost");
      let cost: number;
      if (costHeader !== null) {
        cost = parseFloat(costHeader);
      } else {
        // Fall back to token-based calculation
        cost = inputTokens * fallbackInputTokenCost + outputTokens * fallbackOutputTokenCost;
      }

      const charge = withMargin(cost, marginMultiplier);

      return {
        result: {
          text,
          model: responseModel,
          usage: { inputTokens, outputTokens },
        },
        cost,
        charge,
      };
    },
  };
}
