import type { Provider } from "../security/types.js";

/**
 * Base API URLs used to validate provider keys.
 * Centralised here so every consumer references one source of truth.
 */
export const PROVIDER_API_URLS: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com/v1/models",
  openai: "https://api.openai.com/v1/models",
  google: "https://generativelanguage.googleapis.com/v1/models",
  discord: "https://discord.com/api/v10/users/@me",
  elevenlabs: "https://api.elevenlabs.io/v1/user",
  deepgram: "https://api.deepgram.com/v1/projects",
};
