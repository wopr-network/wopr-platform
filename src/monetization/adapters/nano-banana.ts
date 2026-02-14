/**
 * Nano Banana hosted adapter -- image generation via Google's Gemini API.
 *
 * Nano Banana is an image generation model available through the Gemini
 * Generative Language API. This adapter wraps that endpoint behind the
 * standard ProviderAdapter interface with per-image cost tracking and
 * margin billing.
 *
 * The Gemini image generation endpoint returns base64 encoded images
 * inline in the response candidates.
 */

import type { AdapterResult, ImageGenerationInput, ImageGenerationOutput, ProviderAdapter } from "./types.js";
import { withMargin } from "./types.js";

/** Configuration for the Nano Banana adapter */
export interface NanoBananaAdapterConfig {
  /** Google/Gemini API key (WOPR's pooled wholesale key) */
  apiKey: string;
  /** Gemini API base URL (default: https://generativelanguage.googleapis.com) */
  baseUrl?: string;
  /** Cost per image in USD (default: $0.02 per image) */
  costPerImage?: number;
  /** Margin multiplier (default: 1.3) */
  marginMultiplier?: number;
}

/**
 * A function that performs an HTTP fetch. Accepts the same signature as
 * the global `fetch`. This indirection lets tests inject a stub without
 * mocking globals.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Gemini image generation response (subset we care about) */
interface GeminiImageResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
      }>;
    };
  }>;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_COST_PER_IMAGE = 0.02; // $0.02 per image (Gemini Imagen pricing)
const DEFAULT_MARGIN = 1.3;

/**
 * Create a Nano Banana provider adapter.
 *
 * Uses factory function pattern (not class) to keep the API surface minimal
 * and to allow easy dependency injection of fetch for testing.
 */
export function createNanoBananaAdapter(
  config: NanoBananaAdapterConfig,
  fetchFn: FetchFn = fetch,
): ProviderAdapter & Required<Pick<ProviderAdapter, "generateImage">> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const costPerImage = config.costPerImage ?? DEFAULT_COST_PER_IMAGE;
  const marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN;

  return {
    name: "nano-banana",
    capabilities: ["image-generation"] as const,

    async generateImage(input: ImageGenerationInput): Promise<AdapterResult<ImageGenerationOutput>> {
      const body: Record<string, unknown> = {
        contents: [{ parts: [{ text: input.prompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
          ...(input.count && input.count > 1 ? { candidateCount: input.count } : {}),
        },
      };

      const url = `${baseUrl}/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${config.apiKey}`;

      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const error = Object.assign(new Error("Nano Banana rate limit exceeded"), {
          httpStatus: 429,
          retryAfter: retryAfter ?? undefined,
        });
        throw error;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Nano Banana API error (${res.status}): ${text}`);
      }

      const data = (await res.json()) as GeminiImageResponse;

      // Extract base64 images from response candidates
      const images: string[] = [];
      for (const candidate of data.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.inlineData?.data) {
            images.push(part.inlineData.data);
          }
        }
      }

      if (images.length === 0) {
        throw new Error("Nano Banana returned no images — possible safety filter or empty response");
      }

      const cost = costPerImage * images.length;
      const charge = withMargin(cost, marginMultiplier);

      return {
        result: { images, model: "nano-banana" },
        cost,
        charge,
      };
    },
  };
}
