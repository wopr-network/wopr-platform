import { PROVIDER_API_URLS } from "../config/provider-endpoints.js";
import type { Provider, ProviderEndpoint, ValidateKeyResponse } from "./types.js";

/**
 * Provider API endpoints used for key validation.
 * For CORS-friendly providers, the browser can call these directly.
 * For CORS-blocked providers (e.g., Anthropic), the platform proxy decrypts
 * and validates in memory without ever logging the key.
 * URLs are sourced from PROVIDER_API_URLS; headers are provider-specific.
 */
export const PROVIDER_ENDPOINTS: Record<Provider, ProviderEndpoint> = {
  anthropic: {
    url: PROVIDER_API_URLS.anthropic,
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
  },
  openai: {
    url: PROVIDER_API_URLS.openai,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
    }),
  },
  google: {
    url: PROVIDER_API_URLS.google,
    headers: (key) => ({
      "x-goog-api-key": key,
    }),
  },
  discord: {
    url: PROVIDER_API_URLS.discord,
    headers: (key) => ({
      Authorization: `Bot ${key}`,
    }),
  },
  elevenlabs: {
    url: PROVIDER_API_URLS.elevenlabs,
    headers: (key) => ({
      "xi-api-key": key,
    }),
  },
  deepgram: {
    url: PROVIDER_API_URLS.deepgram,
    headers: (key) => ({
      Authorization: `Token ${key}`,
    }),
  },
};

/**
 * Validate a provider API key by making a lightweight read-only request.
 * The key is held in memory only for the duration of the fetch and then discarded.
 *
 * SECURITY: This function must NEVER log, persist, or return the key itself.
 */
export async function validateProviderKey(provider: Provider, key: string): Promise<ValidateKeyResponse> {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) {
    return { valid: false, error: `Unknown provider: ${provider}` };
  }

  try {
    const response = await fetch(endpoint.url, {
      method: "GET",
      headers: endpoint.headers(key),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { valid: true };
    }

    // 401/403 = invalid key; other errors are transient
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    return { valid: false, error: `Provider returned status ${response.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Validation request failed";
    return { valid: false, error: message };
  }
}
