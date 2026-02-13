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
 * @param cost - Wholesale cost in USD
 * @param marginMultiplier - e.g. 1.3 for 30% margin (default)
 */
export function withMargin(cost: number, marginMultiplier = 1.3): number {
  return Math.round(cost * marginMultiplier * 1_000_000) / 1_000_000; // 6 decimal precision
}
