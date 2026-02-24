import { bodyLimit } from "hono/body-limit";

/**
 * Body size limits for gateway routes (bytes).
 * Prevents memory exhaustion from oversized request payloads.
 */
export const BODY_LIMITS = {
  /** Chat completions, text completions, embeddings, messages */
  LLM: 10 * 1024 * 1024, // 10 MB
  /** Audio transcriptions and speech */
  AUDIO: 25 * 1024 * 1024, // 25 MB
  /** Image and video generation prompts */
  MEDIA: 10 * 1024 * 1024, // 10 MB
  /** Phone, SMS, webhook payloads */
  WEBHOOK: 1 * 1024 * 1024, // 1 MB
} as const;

/** Standard 413 error response matching gateway error format. */
function onBodyLimitError(maxSize: number) {
  return (c: import("hono").Context) =>
    c.json(
      {
        error: {
          message: `Request body too large. Maximum size is ${Math.round(maxSize / (1024 * 1024))}MB.`,
          type: "invalid_request_error",
          code: "request_too_large",
        },
      },
      413,
    );
}

/** Body limit middleware for LLM routes (10MB). */
export const llmBodyLimit = () => bodyLimit({ maxSize: BODY_LIMITS.LLM, onError: onBodyLimitError(BODY_LIMITS.LLM) });

/** Body limit middleware for audio routes (25MB). */
export const audioBodyLimit = () =>
  bodyLimit({ maxSize: BODY_LIMITS.AUDIO, onError: onBodyLimitError(BODY_LIMITS.AUDIO) });

/** Body limit middleware for media generation routes (10MB). */
export const mediaBodyLimit = () =>
  bodyLimit({ maxSize: BODY_LIMITS.MEDIA, onError: onBodyLimitError(BODY_LIMITS.MEDIA) });

/** Body limit middleware for webhook/phone/SMS routes (1MB). */
export const webhookBodyLimit = () =>
  bodyLimit({ maxSize: BODY_LIMITS.WEBHOOK, onError: onBodyLimitError(BODY_LIMITS.WEBHOOK) });
