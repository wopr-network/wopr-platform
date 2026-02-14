import { z } from "zod";
import { discoveryConfigSchema } from "../discovery/types.js";

/** Regex for valid bot names: alphanumeric, hyphens, underscores, 1-63 chars */
const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/**
 * Docker named volume format: starts with alphanumeric, then alphanumeric plus `_`, `.`, `-`.
 * Rejects host paths (starting with `/`, `./`, `~`) and path traversal (`..`).
 */
export const dockerVolumeNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "Must be a valid named Docker volume")
  .refine((v) => !v.startsWith("/") && !v.includes(".."), "Host paths and path traversal are not allowed");

/**
 * Default allowlisted Docker image registry prefixes.
 * Configurable via FLEET_IMAGE_ALLOWLIST env var (comma-separated).
 */
const DEFAULT_IMAGE_ALLOWLIST = ["ghcr.io/wopr-network/"];

function getImageAllowlist(): string[] {
  const envVal = process.env.FLEET_IMAGE_ALLOWLIST;
  if (envVal) {
    const parsed = envVal
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => (p.endsWith("/") || p.endsWith(":") ? p : `${p}/`));
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_IMAGE_ALLOWLIST;
}

/** Zod refinement that restricts Docker images to allowlisted registry prefixes. */
export const imageSchema = z
  .string()
  .min(1, "Image is required")
  .superRefine((image, ctx) => {
    const allowlist = getImageAllowlist();
    if (!allowlist.some((prefix) => image.startsWith(prefix))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Image "${image}" is not from an allowlisted registry. Allowed prefixes: ${allowlist.join(", ")}`,
      });
    }
  });

/** Release channels for container images */
export const releaseChannelSchema = z.enum(["canary", "staging", "stable", "pinned"]);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

/** Update policy for automatic container updates */
export const updatePolicySchema = z.union([
  z.enum(["on-push", "nightly", "manual"]),
  z.string().regex(/^cron:.+$/, "Cron policy must be in format 'cron:<expression>'"),
]);
export type UpdatePolicy = z.infer<typeof updatePolicySchema>;

/** Schema for a bot profile template (persisted as YAML) */
export const botProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().regex(nameRegex, "Name must be 1-63 alphanumeric chars, hyphens, or underscores"),
  description: z.string().default(""),
  image: imageSchema,
  env: z.record(z.string(), z.string()).default({}),
  restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]).default("unless-stopped"),
  volumeName: dockerVolumeNameSchema.optional(),
  releaseChannel: releaseChannelSchema.default("stable"),
  updatePolicy: updatePolicySchema.default("manual"),
  /** Optional P2P discovery configuration. Defaults to enabled with no extra topics. */
  discovery: discoveryConfigSchema.optional(),
});

export type BotProfile = z.infer<typeof botProfileSchema>;

/** Schema for creating a bot via the API */
export const createBotSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().regex(nameRegex, "Name must be 1-63 alphanumeric chars, hyphens, or underscores")),
  description: z.string().default(""),
  image: imageSchema,
  env: z.record(z.string(), z.string()).default({}),
  restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]).default("unless-stopped"),
  volumeName: dockerVolumeNameSchema.optional(),
  releaseChannel: releaseChannelSchema.default("stable"),
  updatePolicy: updatePolicySchema.default("manual"),
  /** Optional P2P discovery configuration. */
  discovery: discoveryConfigSchema.optional(),
});

/** Schema for updating a bot via the API */
export const updateBotSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().regex(nameRegex, "Name must be 1-63 alphanumeric chars, hyphens, or underscores"))
    .optional(),
  description: z.string().optional(),
  image: imageSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]).optional(),
  volumeName: dockerVolumeNameSchema.optional(),
  releaseChannel: releaseChannelSchema.optional(),
  updatePolicy: updatePolicySchema.optional(),
  /** Optional P2P discovery configuration override. */
  discovery: discoveryConfigSchema.optional(),
});

/** Container resource usage stats */
export interface ContainerStats {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  memoryPercent: number;
}

/** Live status information for a bot */
export interface BotStatus {
  id: string;
  name: string;
  description: string;
  image: string;
  containerId: string | null;
  state: "running" | "stopped" | "error" | "pulling" | "created" | "restarting" | "paused" | "exited" | "dead";
  health: string | null;
  uptime: string | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: ContainerStats | null;
}

/** Image status showing current vs available digest */
export interface ImageStatus {
  botId: string;
  currentDigest: string | null;
  availableDigest: string | null;
  updateAvailable: boolean;
  releaseChannel: ReleaseChannel;
  updatePolicy: UpdatePolicy;
  lastCheckedAt: string | null;
}
