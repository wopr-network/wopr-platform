/**
 * Kimi K3 hosted adapter -- text generation via Moonshot AI's OpenAI-compatible API.
 *
 * Kimi offers competitive pricing on reasoning-capable models, making it
 * useful for arbitrage on complex prompts where reasoning quality matters.
 *
 * Cost is calculated from the usage object returned by the chat completions
 * API (prompt_tokens + completion_tokens) using configured per-model rates.
 */

import { Credit } from "../credit.js";
import type { AdapterResult, ProviderAdapter, TextGenerationInput, TextGenerationOutput } from "./types.js";
import { withMargin } from "./types.js";

/** Configuration for the Kimi adapter */
export interface KimiAdapterConfig {
  /** Moonshot API key (WOPR's pooled wholesale key) */
  apiKey: string;
  /** Kimi API base URL (default: https://api.moonshot.cn) */
  baseUrl?: string;
  /** Default model (default: "kimi-k3") */
  defaultModel?: string;
  /** Cost per 1M input tokens in USD (default: $0.35) */
  inputTokenCostPer1M?: number;
  /** Cost per 1M output tokens in USD (default: $1.40) */
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

const DEFAULT_BASE_URL = "https://api.moonshot.cn";
const DEFAULT_MODEL = "kimi-k3";
const DEFAULT_MARGIN = 1.3;
// Kimi K3 pricing estimates
const DEFAULT_INPUT_COST_PER_1M = 0.35; // $0.35 per 1M input tokens
const DEFAULT_OUTPUT_COST_PER_1M = 1.4; // $1.40 per 1M output tokens

/**
 * Create a Kimi provider adapter.
 *
 * Uses factory function pattern (not class) to keep the API surface minimal
 * and to allow easy dependency injection of fetch for testing.
 */
export function createKimiAdapter(
  config: KimiAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "generateText">> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;
  const inputCostPer1M = config.inputTokenCostPer1M ?? DEFAULT_INPUT_COST_PER_1M;
  const outputCostPer1M = config.outputTokenCostPer1M ?? DEFAULT_OUTPUT_COST_PER_1M;

  return {
    name: "kimi",
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
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const error = Object.assign(new Error("Kimi rate limit exceeded"), {
          httpStatus: 429,
          retryAfter: retryAfter ?? undefined,
        });
        throw error;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Kimi API error (${res.status}): ${text}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;

      const text = data.choices[0]?.message?.content ?? "";
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;

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
