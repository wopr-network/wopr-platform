/**
 * Error mapping — translates upstream provider errors into standard gateway responses.
 *
 * Bots should never see raw Deepgram, OpenRouter, or Twilio errors.
 * Everything is normalized to OpenAI-compatible error format.
 */

import type { GatewayErrorResponse } from "./types.js";

/** Map a circuit breaker trip to a gateway error response. */
export function mapCircuitBreakerError(
  _instanceId: string,
  pausedUntil: number,
): { status: number; body: GatewayErrorResponse } {
  return {
    status: 429,
    body: {
      error: {
        message: `Circuit breaker triggered: too many requests from this bot instance. Paused until ${new Date(pausedUntil).toISOString()}.`,
        type: "rate_limit_error",
        code: "circuit_breaker_tripped",
      },
    },
  };
}

/** Map a credits-exhausted state to a gateway error response. */
export function mapCreditsExhaustedError(
  _currentBalanceCents: number,
  topUpUrl: string,
): { status: number; body: GatewayErrorResponse & { needsCredits: boolean; topUpUrl: string } } {
  return {
    status: 402,
    body: {
      error: {
        message: "Your credits are exhausted. Add credits to continue using your bot.",
        type: "billing_error",
        code: "credits_exhausted",
      },
      needsCredits: true,
      topUpUrl,
    },
  };
}

/** Map a spending cap exceeded to a gateway error response. */
export function mapSpendingCapError(
  capType: string,
  currentSpend: number,
  cap: number,
): { status: number; body: GatewayErrorResponse } {
  return {
    status: 402,
    body: {
      error: {
        message: `${capType.charAt(0).toUpperCase() + capType.slice(1)} spending cap exceeded: $${currentSpend.toFixed(2)}/$${cap.toFixed(2)}. Adjust your cap in settings to continue.`,
        type: "billing_error",
        code: "spending_cap_exceeded",
      },
    },
  };
}

/** Map a budget check result to the appropriate HTTP status for the inference gateway. */
export function mapBudgetError(reason: string): { status: number; body: GatewayErrorResponse } {
  // Insufficient credits → 402 Payment Required
  if (reason.includes("spending limit") || reason.includes("Budget exceeded")) {
    return {
      status: 402,
      body: {
        error: {
          message: `${reason}. Add credits at https://wopr.bot/billing to continue.`,
          type: "billing_error",
          code: "insufficient_credits",
        },
      },
    };
  }

  // Rate limit → 429
  return {
    status: 429,
    body: {
      error: {
        message: reason,
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    },
  };
}

/** Map an upstream error to a gateway error response with HTTP status. */
export function mapProviderError(error: unknown, provider: string): { status: number; body: GatewayErrorResponse } {
  const err = error instanceof Error ? error : new Error(String(error));
  const errWithStatus = err as Error & { httpStatus?: number; retryAfter?: string };

  // Budget exceeded (from our budget checker) — check message first so spending-limit
  // errors with httpStatus 429 are classified as billing_error, not rate_limit_error.
  if (err.message.includes("spending limit")) {
    return {
      status: 429,
      body: {
        error: {
          message: err.message,
          type: "billing_error",
          code: "insufficient_credits",
        },
      },
    };
  }

  // Rate limit from upstream
  if (errWithStatus.httpStatus === 429) {
    return {
      status: 429,
      body: {
        error: {
          message: "Rate limit exceeded. Please retry after a brief delay.",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
    };
  }

  // Budget check unavailable
  if (errWithStatus.httpStatus === 503) {
    return {
      status: 503,
      body: {
        error: {
          message: "Service temporarily unavailable. Please try again.",
          type: "server_error",
          code: "service_unavailable",
        },
      },
    };
  }

  // Provider returned 4xx
  if (errWithStatus.httpStatus && errWithStatus.httpStatus >= 400 && errWithStatus.httpStatus < 500) {
    return {
      status: errWithStatus.httpStatus,
      body: {
        error: {
          message: `Upstream error from ${provider}: ${err.message}`,
          type: "upstream_error",
          code: "provider_error",
        },
      },
    };
  }

  // Default: 502 Bad Gateway
  return {
    status: 502,
    body: {
      error: {
        message: "An error occurred while processing your request.",
        type: "server_error",
        code: "upstream_error",
      },
    },
  };
}
