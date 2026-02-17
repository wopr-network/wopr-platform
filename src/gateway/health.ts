/**
 * Gateway health endpoint — reports gateway and backend health status.
 *
 * Checks configured providers and GPU backends, returning overall health
 * status with per-backend details.
 */

import type { Context } from "hono";
import { logger } from "../config/logger.js";
import type { ProxyDeps } from "./proxy.js";

interface BackendHealth {
  name: string;
  status: "healthy" | "unhealthy" | "unknown";
  latency?: number;
  error?: string;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  backends: BackendHealth[];
}

/**
 * GET /health handler — checks gateway and backend health.
 */
export function gatewayHealthHandler(deps: ProxyDeps) {
  return async (_c: Context): Promise<Response> => {
    const backends: BackendHealth[] = [];
    const healthChecks: Promise<BackendHealth>[] = [];

    // Check GPU backends if configured
    if (deps.providers.gpu) {
      if (deps.providers.gpu.textGen) {
        healthChecks.push(checkBackendHealth(deps, "gpu-text-gen", deps.providers.gpu.textGen.baseUrl));
      }
      if (deps.providers.gpu.tts) {
        healthChecks.push(checkBackendHealth(deps, "gpu-tts", deps.providers.gpu.tts.baseUrl));
      }
      if (deps.providers.gpu.stt) {
        healthChecks.push(checkBackendHealth(deps, "gpu-stt", deps.providers.gpu.stt.baseUrl));
      }
      if (deps.providers.gpu.embeddings) {
        healthChecks.push(checkBackendHealth(deps, "gpu-embeddings", deps.providers.gpu.embeddings.baseUrl));
      }
    }

    // Check hosted providers — validate API keys are configured (minimal check)
    if (deps.providers.openrouter) {
      backends.push({
        name: "openrouter",
        status: deps.providers.openrouter.apiKey ? "healthy" : "unhealthy",
        error: deps.providers.openrouter.apiKey ? undefined : "API key not configured",
      });
    }
    if (deps.providers.deepgram) {
      backends.push({
        name: "deepgram",
        status: deps.providers.deepgram.apiKey ? "healthy" : "unhealthy",
        error: deps.providers.deepgram.apiKey ? undefined : "API key not configured",
      });
    }
    if (deps.providers.elevenlabs) {
      backends.push({
        name: "elevenlabs",
        status: deps.providers.elevenlabs.apiKey ? "healthy" : "unhealthy",
        error: deps.providers.elevenlabs.apiKey ? undefined : "API key not configured",
      });
    }
    if (deps.providers.replicate) {
      backends.push({
        name: "replicate",
        status: deps.providers.replicate.apiToken ? "healthy" : "unhealthy",
        error: deps.providers.replicate.apiToken ? undefined : "API token not configured",
      });
    }
    if (deps.providers.twilio) {
      backends.push({
        name: "twilio",
        status: deps.providers.twilio.accountSid && deps.providers.twilio.authToken ? "healthy" : "unhealthy",
        error:
          deps.providers.twilio.accountSid && deps.providers.twilio.authToken
            ? undefined
            : "Account SID or auth token not configured",
      });
    }
    if (deps.providers.telnyx) {
      backends.push({
        name: "telnyx",
        status: deps.providers.telnyx.apiKey ? "healthy" : "unhealthy",
        error: deps.providers.telnyx.apiKey ? undefined : "API key not configured",
      });
    }

    // Wait for GPU backend health checks (with timeout)
    const gpuHealthResults = await Promise.allSettled(healthChecks);
    for (const result of gpuHealthResults) {
      if (result.status === "fulfilled") {
        backends.push(result.value);
      } else {
        backends.push({
          name: "gpu-backend",
          status: "unhealthy",
          error: String(result.reason),
        });
      }
    }

    // Determine overall status
    const unhealthyCount = backends.filter((b) => b.status === "unhealthy").length;
    const overallStatus =
      unhealthyCount === 0 ? "healthy" : unhealthyCount < backends.length ? "degraded" : "unhealthy";

    const response: HealthResponse = {
      status: overallStatus,
      timestamp: Date.now(),
      backends,
    };

    const httpStatus = overallStatus === "healthy" ? 200 : overallStatus === "degraded" ? 200 : 503;

    return new Response(JSON.stringify(response), {
      status: httpStatus,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * Check health of a single GPU backend with 2s timeout.
 */
async function checkBackendHealth(deps: ProxyDeps, name: string, baseUrl: string): Promise<BackendHealth> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await deps.fetchFn(`${baseUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;

    if (res.ok) {
      // Validate Content-Type is application/json before parsing
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        logger.warn("GPU backend health check returned non-JSON response", {
          name,
          baseUrl,
          contentType,
        });
        return {
          name,
          status: "unhealthy",
          latency,
          error: `Invalid Content-Type: ${contentType}`,
        };
      }

      // Optional: Parse and validate JSON structure
      try {
        await res.json();
      } catch {
        return {
          name,
          status: "unhealthy",
          latency,
          error: "Invalid JSON response",
        };
      }

      return { name, status: "healthy", latency };
    } else {
      return {
        name,
        status: "unhealthy",
        latency,
        error: `HTTP ${res.status}`,
      };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;

    logger.warn("GPU backend health check failed", { name, baseUrl, error });

    return {
      name,
      status: "unhealthy",
      latency,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
