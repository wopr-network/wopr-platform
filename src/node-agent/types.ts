import { z } from "zod";

/** Agent version string, read from package.json at build time */
export const AGENT_VERSION = "1.0.0";

/** Container name prefix for tenant containers managed by this agent */
export const TENANT_PREFIX = "tenant_";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const nodeAgentConfigSchema = z
  .object({
    /** Platform API base URL (must be HTTPS except for localhost dev) */
    platformUrl: z
      .string()
      .url()
      .refine((url) => {
        const parsed = new URL(url);
        const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
        return parsed.protocol === "https:" || isLocalhost;
      }, "platformUrl must use HTTPS (http:// only allowed for localhost)"),
    /** Unique node identifier — assigned by platform during token registration */
    nodeId: z.string().min(1).optional(),
    /** Persistent per-node secret for authentication (assigned after first registration) */
    nodeSecret: z.string().optional(),
    /** One-time registration token for first-time setup */
    registrationToken: z.string().optional(),
    /** Heartbeat interval in milliseconds */
    heartbeatIntervalMs: z.coerce.number().int().min(1000).default(30_000),
    /** Backup directory path */
    backupDir: z.string().default("/backups"),
    /** S3 bucket for backups */
    s3Bucket: z.string().default("wopr-backups"),
    /** Path to persist credentials after token registration */
    credentialsPath: z.string().default("/etc/wopr/credentials.json"),
  })
  .refine((c) => c.nodeSecret || c.registrationToken, "Either nodeSecret or registrationToken is required");

export type NodeAgentConfig = z.infer<typeof nodeAgentConfigSchema>;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface NodeRegistration {
  node_id: string;
  host: string;
  capacity_mb: number;
  agent_version: string;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export interface ContainerMetric {
  name: string;
  status: string;
  memory_mb: number;
  uptime_s: number;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  node_id: string;
  uptime_s: number;
  memory_total_mb: number;
  memory_used_mb: number;
  disk_total_gb: number;
  disk_used_gb: number;
  containers?: ContainerMetric[];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** All command types the agent accepts. Anything else is rejected. */
export const ALLOWED_COMMANDS = [
  "bot.start",
  "bot.stop",
  "bot.restart",
  "bot.update",
  "bot.export",
  "bot.import",
  "bot.remove",
  "bot.logs",
  "bot.inspect",
  "backup.upload",
  "backup.download",
  "backup.run-nightly",
  "backup.run-hot",
] as const;

export type CommandType = (typeof ALLOWED_COMMANDS)[number];

/** Inbound command from the platform API */
export const commandSchema = z.object({
  id: z.string(),
  type: z.enum(ALLOWED_COMMANDS),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type Command = z.infer<typeof commandSchema>;

/** Result sent back to the platform after command execution */
export interface CommandResult {
  id: string;
  type: "command_result";
  command: CommandType;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Health events
// ---------------------------------------------------------------------------

export interface HealthEvent {
  type: "health_event";
  node_id: string;
  container: string;
  event: "died" | "oom_killed" | "unhealthy" | "restarted" | "disk_low";
  message: string;
  timestamp: string;
}
