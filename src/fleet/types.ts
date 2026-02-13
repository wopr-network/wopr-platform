import { z } from "zod";

/** Regex for valid bot names: alphanumeric, hyphens, underscores, 1-63 chars */
const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

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
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]).default("unless-stopped"),
  volumeName: z.string().optional(),
  releaseChannel: releaseChannelSchema.default("stable"),
  updatePolicy: updatePolicySchema.default("manual"),
});

export type BotProfile = z.infer<typeof botProfileSchema>;

/** Schema for creating a bot via the API */
export const createBotSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().regex(nameRegex, "Name must be 1-63 alphanumeric chars, hyphens, or underscores")),
  description: z.string().default(""),
  image: z.string().min(1, "Image is required"),
  env: z.record(z.string(), z.string()).default({}),
  restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]).default("unless-stopped"),
  volumeName: z.string().optional(),
  releaseChannel: releaseChannelSchema.default("stable"),
  updatePolicy: updatePolicySchema.default("manual"),
});

/** Schema for updating a bot via the API */
export const updateBotSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().regex(nameRegex, "Name must be 1-63 alphanumeric chars, hyphens, or underscores"))
    .optional(),
  description: z.string().optional(),
  image: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  restartPolicy: z.enum(["no", "always", "on-failure", "unless-stopped"]).optional(),
  volumeName: z.string().optional(),
  releaseChannel: releaseChannelSchema.optional(),
  updatePolicy: updatePolicySchema.optional(),
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
