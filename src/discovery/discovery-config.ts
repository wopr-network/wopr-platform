import {
  DEFAULT_DISCOVERY_TOPIC,
  DISCOVERY_TOPICS_ENV,
  type DiscoveryConfig,
  type PlatformDiscoveryConfig,
} from "./types.js";

/**
 * Build the discovery environment variables to inject into an instance container.
 *
 * Returns a record of env vars to merge into the container's Env.
 * If discovery is disabled, returns an empty record (no env var injected,
 * so the P2P plugin won't join any discovery topics).
 *
 * @param instanceConfig - Per-instance discovery settings (from profile/template)
 * @param platformConfig - Platform-level discovery settings (from platform config)
 */
export function buildDiscoveryEnv(
  instanceConfig?: DiscoveryConfig | undefined,
  platformConfig?: PlatformDiscoveryConfig | undefined,
): Record<string, string> {
  // If no instance config provided, use defaults (enabled, no extra topics)
  const config: DiscoveryConfig = instanceConfig ?? { enabled: true, topics: [] };
  const defaultTopic = platformConfig?.defaultTopic ?? DEFAULT_DISCOVERY_TOPIC;

  if (!config.enabled) {
    return {};
  }

  // Start with the global default topic, then add any instance-specific topics
  const topics = new Set<string>();
  topics.add(defaultTopic);

  for (const topic of config.topics) {
    topics.add(topic);
  }

  return {
    [DISCOVERY_TOPICS_ENV]: [...topics].join(","),
  };
}
