/** Maps an abstract capability name to the env var and credential vault provider name. */
export interface CapabilityEnvEntry {
  /** Env var name injected into bot profile (e.g., "ELEVENLABS_API_KEY") */
  envKey: string;
  /** Provider name in the CredentialVaultStore (e.g., "elevenlabs") */
  vaultProvider: string;
}

/**
 * Static map: capability name -> env injection info.
 * Source of truth for which env var to inject when a user chooses "hosted".
 */
export const CAPABILITY_ENV_MAP: Record<string, CapabilityEnvEntry> = {
  tts: { envKey: "ELEVENLABS_API_KEY", vaultProvider: "elevenlabs" },
  stt: { envKey: "DEEPGRAM_API_KEY", vaultProvider: "deepgram" },
  llm: { envKey: "OPENROUTER_API_KEY", vaultProvider: "openrouter" },
  "image-gen": { envKey: "REPLICATE_API_TOKEN", vaultProvider: "replicate" },
  embeddings: { envKey: "OPENROUTER_API_KEY", vaultProvider: "openrouter" },
};

/**
 * Look up the env injection info for a capability.
 * Returns null if the capability is not in the map.
 */
export function lookupCapabilityEnv(capability: string): CapabilityEnvEntry | null {
  return CAPABILITY_ENV_MAP[capability] ?? null;
}
