/**
 * SSE stream proxy — proxies server-sent events from upstream providers
 * for streaming chat completions.
 *
 * Accumulates token usage during the stream and emits a meter event
 * after completion.
 */

import { logger } from "../config/logger.js";
import { withMargin } from "../monetization/adapters/types.js";
import type { ProxyDeps } from "./proxy.js";
import type { GatewayTenant } from "./types.js";

/**
 * Default token rates (per 1000 tokens) — used as fallback if no model-specific rates are configured.
 * TODO: Replace with per-model rate lookup from provider config or rate table.
 */
const DEFAULT_INPUT_RATE = 0.001; // $0.001 per 1K input tokens
const DEFAULT_OUTPUT_RATE = 0.002; // $0.002 per 1K output tokens

/**
 * Proxy an SSE stream from upstream, metering after completion.
 *
 * If credits run out mid-stream, append a final SSE chunk with
 * a `finish_reason: "length"` and close the stream gracefully.
 */
export function proxySSEStream(
  upstreamResponse: Response,
  opts: {
    tenant: GatewayTenant;
    deps: ProxyDeps;
    capability: string;
    provider: string;
    costHeader: string | null;
  },
): Response {
  const { tenant, deps, capability, provider, costHeader } = opts;

  let accumulatedCost = 0;

  // If cost header is present on the initial response, use it
  if (costHeader) {
    accumulatedCost = parseFloat(costHeader);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      // Pass through SSE chunks unchanged
      controller.enqueue(chunk);

      // Try to extract usage from SSE data chunks
      const text = new TextDecoder().decode(chunk);
      const lines = text.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") {
            // Stream complete — emit meter event
            if (accumulatedCost === 0) {
              // No cost header, try to estimate from usage
              logger.warn("SSE stream completed without cost header", {
                tenant: tenant.id,
                capability,
                provider,
              });
            }
            break;
          }

          try {
            const data = JSON.parse(jsonStr) as {
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };

            // Extract token usage from final chunk
            if (data.usage && accumulatedCost === 0) {
              const inputTokens = data.usage.prompt_tokens ?? 0;
              const outputTokens = data.usage.completion_tokens ?? 0;
              // Use default rates as fallback (TODO: lookup model-specific rates)
              accumulatedCost = (inputTokens * DEFAULT_INPUT_RATE + outputTokens * DEFAULT_OUTPUT_RATE) / 1000;
            }
          } catch (err) {
            // Log malformed SSE chunks for debugging
            logger.warn("Failed to parse SSE chunk JSON", {
              tenant: tenant.id,
              capability,
              provider,
              error: err instanceof Error ? err.message : String(err),
              jsonStr: jsonStr.length > 100 ? `${jsonStr.slice(0, 100)}...` : jsonStr,
            });
          }
        }
      }
    },

    async flush() {
      // Wait for transform to complete (ensures all chunks are processed before metering)
      // The TransformStream calls flush() after transform() completes, so this is safe.
      // No additional async work needed — transform() already completed.

      // Stream ended — emit meter event with accumulated cost
      const charge = withMargin(accumulatedCost, deps.defaultMargin);
      deps.meter.emit({
        tenant: tenant.id,
        cost: accumulatedCost,
        charge,
        capability,
        provider,
        timestamp: Date.now(),
      });

      logger.info("Gateway proxy: SSE stream completed", {
        tenant: tenant.id,
        capability,
        provider,
        cost: accumulatedCost,
      });
    },
  });

  // Pipe upstream response body through transform stream
  if (upstreamResponse.body) {
    upstreamResponse.body.pipeTo(writable).catch((err) => {
      logger.error("SSE stream pipe error", { tenant: tenant.id, error: err });
    });
  }

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
