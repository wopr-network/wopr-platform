import { z } from "zod";

/** The global default discovery topic all instances can join. */
export const DEFAULT_DISCOVERY_TOPIC = "wopr-service";

/** Env var name injected into WOPR instance containers for discovery topics. */
export const DISCOVERY_TOPICS_ENV = "WOPR_DISCOVERY_TOPICS";

/**
 * Per-instance discovery configuration.
 * Used in profile templates and the create-bot API.
 */
export const discoveryConfigSchema = z.object({
  /**
   * Whether this instance participates in discovery.
   * Defaults to true (opt-out model).
   */
  enabled: z.boolean().default(true),

  /**
   * Additional discovery topics beyond the global default.
   * Useful for per-org or per-user private discovery groups.
   * Example: ["wopr-org-acme", "wopr-team-red"]
   */
  topics: z.array(z.string().min(1).max(128)).default([]),
});

export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;

/**
 * Platform-level discovery settings (from environment / platform config).
 */
export const platformDiscoveryConfigSchema = z.object({
  /** The default global topic. All instances join this unless discovery is disabled. */
  defaultTopic: z.string().min(1).default(DEFAULT_DISCOVERY_TOPIC),
});

export type PlatformDiscoveryConfig = z.infer<typeof platformDiscoveryConfigSchema>;
