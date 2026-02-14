/**
 * Provider adapter interface — the contract every hosted adapter implements.
 *
 * An adapter wraps a wholesale AI provider (Replicate, RunPod, etc.) and returns
 * the raw result plus the wholesale cost. The socket layer handles margin,
 * metering, and billing — adapters never touch those concerns.
 */

/** The result every adapter returns: the provider's output + wholesale cost */
export interface AdapterResult<T = unknown> {
  /** The provider's response payload */
  result: T;
  /** Wholesale cost in USD (what we paid the provider) */
  cost: number;
  /** User-facing charge in USD (cost + margin). Present when the adapter computes margin. */
  charge?: number;
}

/** A capability the adapter supports (extensible as we add more) */
export type AdapterCapability = "transcription" | "image-generation" | "embeddings" | "text-generation";

/** Input for a transcription request */
export interface TranscriptionInput {
  /** URL of the audio file to transcribe */
  audioUrl: string;
  /** Optional language hint (ISO 639-1) */
  language?: string;
}

/** Output from a transcription request */
export interface TranscriptionOutput {
  /** The transcribed text */
  text: string;
  /** Detected language (ISO 639-1) */
  detectedLanguage: string;
  /** Duration of the audio in seconds */
  durationSeconds: number;
}

/** Input for an image generation request */
export interface ImageGenerationInput {
  /** The prompt describing the desired image */
  prompt: string;
  /** Optional negative prompt */
  negativePrompt?: string;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** Number of images to generate (default: 1) */
  count?: number;
}

/** Output from an image generation request */
export interface ImageGenerationOutput {
  /** URLs or base64 data of generated images */
  images: string[];
  /** Model used for generation */
  model: string;
}

/** Input for a text generation request */
export interface TextGenerationInput {
  /** The prompt or messages */
  prompt: string;
  /** Model to use */
  model?: string;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Temperature (0-1) */
  temperature?: number;
}

/** Output from a text generation request */
export interface TextGenerationOutput {
  /** Generated text */
  text: string;
  /** Model used */
  model: string;
  /** Token counts for cost calculation */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Provider adapter interface.
 *
 * Each hosted provider (Replicate, RunPod, etc.) implements this interface
 * for every capability it supports. The adapter is the invisible layer between
 * the socket and the wholesale provider.
 */
export interface ProviderAdapter {
  /** Human-readable provider name */
  readonly name: string;
  /** Which capabilities this adapter supports */
  readonly capabilities: ReadonlyArray<AdapterCapability>;
  /** Transcribe audio — returns result + wholesale cost */
  transcribe?(input: TranscriptionInput): Promise<AdapterResult<TranscriptionOutput>>;
  /** Generate images from a text prompt — returns result + wholesale cost */
  generateImage?(input: ImageGenerationInput): Promise<AdapterResult<ImageGenerationOutput>>;
  /** Generate text from a prompt — returns result + wholesale cost */
  generateText?(input: TextGenerationInput): Promise<AdapterResult<TextGenerationOutput>>;
}

/**
 * Meter event emitted after a successful adapter call.
 * The metering layer (WOP-299) consumes these to report usage to Stripe.
 */
export interface MeterEvent {
  /** Which adapter produced this event */
  adapter: string;
  /** Which capability was used */
  capability: AdapterCapability;
  /** Wholesale cost in USD (what we paid) */
  cost: number;
  /** Charge to the user in USD (cost + margin) */
  charge: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Opaque user/tenant identifier */
  tenantId: string;
}

/**
 * Apply a margin multiplier to a wholesale cost.
 *
 * This is the core of the socket billing pattern (WOP-298): the adapter returns
 * wholesale cost, withMargin() computes the user-facing charge.
 *
 * Supports tier-specific markup percentages (WOP-357):
 * - Free tier: 20% markup
 * - Pro tier: 10% markup
 * - Enterprise tier: 5-8% markup
 *
 * @param cost - Wholesale cost in USD
 * @param marginMultiplier - Can be:
 *                          - A multiplier >= 1.0 (e.g., 1.3 for 30% margin, 2.0 for 2x - default 1.3)
 *                          - A percentage 3-100 (e.g., 20 for 20% markup, 10 for 10% - WOP-357)
 */
export function withMargin(cost: number, marginMultiplier: number = 1.3): number {
  let multiplier = marginMultiplier;

  // If value is >= 3, treat as percentage (e.g., 20 for 20%, 10 for 10%)
  // If value is >= 1 but < 3, treat as multiplier (e.g., 1.3 = 30%, 2.0 = 2x)
  if (marginMultiplier >= 3 && marginMultiplier <= 100) {
    multiplier = 1 + marginMultiplier / 100;
  }

  return Math.round(cost * multiplier * 1_000_000) / 1_000_000; // 6 decimal precision
}
