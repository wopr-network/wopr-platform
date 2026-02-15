/**
 * Base configuration and utilities for self-hosted GPU adapters.
 *
 * Self-hosted adapters point at our own GPU containers instead of third-party
 * APIs. They implement the same ProviderAdapter interface, but with lower costs
 * (amortized hardware vs API invoices) and no external API keys required.
 */

/**
 * A function that performs an HTTP fetch. Same as the global fetch signature.
 * This indirection lets tests inject stubs without mocking globals.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Base configuration shared by all self-hosted adapters. */
export interface SelfHostedAdapterConfig {
  /** Internal URL of the GPU container (e.g., "http://chatterbox:8000") */
  baseUrl: string;
  /** Cost per unit (amortized GPU time) — set per-adapter */
  costPerUnit: number;
  /** Margin multiplier (self-hosted = lower margin = cheaper for users) */
  marginMultiplier?: number;
  /** Health check endpoint path (default: "/health") */
  healthPath?: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
}

/**
 * Check whether the GPU container is healthy.
 *
 * Makes an HTTP GET request to the health endpoint and returns true if the
 * response is 200-299. Returns false for any error (network, timeout, non-2xx).
 *
 * @param baseUrl - Base URL of the GPU container
 * @param healthPath - Health check endpoint path (default: "/health")
 * @param fetchFn - Fetch implementation (injected for testing)
 * @returns Promise that resolves to true if healthy, false otherwise
 */
export async function checkHealth(
  baseUrl: string,
  healthPath: string = "/health",
  fetchFn: FetchFn = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseUrl}${healthPath}`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5s timeout for health checks
    });
    return res.ok;
  } catch {
    return false;
  }
}
