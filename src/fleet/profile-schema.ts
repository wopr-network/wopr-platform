import { z } from "zod";
import { discoveryConfigSchema } from "../discovery/types.js";

/** Release channels for bot deployments */
export const releaseChannelSchema = z.enum(["stable", "canary", "staging"]);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

/** Restart policy for bot containers */
export const restartPolicySchema = z.enum(["no", "always", "on-failure", "unless-stopped"]);
export type RestartPolicy = z.infer<typeof restartPolicySchema>;

/** Health check configuration */
export const healthCheckSchema = z.object({
  endpoint: z.string().default("/health"),
  intervalSeconds: z.number().int().positive().default(30),
  timeoutSeconds: z.number().int().positive().default(5),
  retries: z.number().int().nonnegative().default(3),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

/** Volume mount configuration */
export const volumeMountSchema = z.object({
  host: z.string(),
  container: z.string(),
  readonly: z.boolean().default(false),
});
export type VolumeMount = z.infer<typeof volumeMountSchema>;

/** Bot profile template schema — validated when loading YAML templates */
export const profileTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  channel: z.object({
    plugin: z.string().min(1),
    config: z.record(z.string(), z.string()).default(() => ({})),
  }),
  provider: z.object({
    plugin: z.string().min(1),
    config: z.record(z.string(), z.string()).default(() => ({})),
  }),
  release: releaseChannelSchema,
  image: z.string().min(1),
  restartPolicy: restartPolicySchema.default("unless-stopped"),
  healthCheck: healthCheckSchema.default(() => ({
    endpoint: "/health",
    intervalSeconds: 30,
    timeoutSeconds: 5,
    retries: 3,
  })),
  volumes: z.array(volumeMountSchema).default(() => []),
  env: z.record(z.string(), z.string()).default(() => ({})),
  /** Optional P2P discovery configuration. Defaults to enabled with no extra topics. */
  discovery: discoveryConfigSchema.optional(),
});

export type ProfileTemplate = z.infer<typeof profileTemplateSchema>;
