import { z } from "zod";

/** Trigger types for snapshot creation */
export const snapshotTriggerSchema = z.enum(["manual", "scheduled", "pre_update"]);
export type SnapshotTrigger = z.infer<typeof snapshotTriggerSchema>;

/** Subscription tiers per WOP-440 */
export const tierSchema = z.enum(["free", "starter", "pro", "enterprise"]);
export type Tier = z.infer<typeof tierSchema>;

/** On-demand snapshot limits by tier */
export interface SnapshotTierPolicy {
  nightlyDailyCount: number;
  nightlyWeeklyCount: number;
  onDemandMax: number;
  retentionDays: number;
}

export const SNAPSHOT_TIER_POLICIES: Record<Tier, SnapshotTierPolicy> = {
  free: { nightlyDailyCount: 3, nightlyWeeklyCount: 0, onDemandMax: 1, retentionDays: 7 },
  starter: { nightlyDailyCount: 7, nightlyWeeklyCount: 4, onDemandMax: 5, retentionDays: 30 },
  pro: { nightlyDailyCount: 7, nightlyWeeklyCount: 4, onDemandMax: 20, retentionDays: 90 },
  enterprise: { nightlyDailyCount: 7, nightlyWeeklyCount: 4, onDemandMax: Number.MAX_SAFE_INTEGER, retentionDays: 365 },
};

/** Tier-based retention policy (legacy — kept for backward compat with retention.ts) */
export interface RetentionPolicy {
  maxSnapshots: number;
  autoSchedule: "none" | "daily" | "hourly" | "configurable";
}

/** Retention policies per tier (maps new tiers to legacy retention shape) */
export const RETENTION_POLICIES: Record<Tier, RetentionPolicy> = {
  free: { maxSnapshots: 3, autoSchedule: "none" },
  starter: { maxSnapshots: 7, autoSchedule: "daily" },
  pro: { maxSnapshots: 7, autoSchedule: "daily" },
  enterprise: { maxSnapshots: Number.MAX_SAFE_INTEGER, autoSchedule: "configurable" },
};

/** Storage pricing constants */
export const STORAGE_COST_PER_GB_MONTH = 0.02; // Our cost from DO Spaces
export const STORAGE_CHARGE_PER_GB_MONTH = 0.05; // What we charge tenants (2.5x margin)

/** Snapshot metadata stored in SQLite */
export interface Snapshot {
  id: string;
  tenant: string;
  instanceId: string;
  userId: string;
  name: string | null;
  type: "nightly" | "on-demand" | "pre-restore";
  s3Key: string | null;
  sizeMb: number;
  sizeBytes: number | null;
  nodeId: string | null;
  createdAt: string;
  expiresAt: number | null;
  deletedAt: number | null;
  trigger: SnapshotTrigger;
  plugins: string[];
  configHash: string;
  storagePath: string;
}

/** Row shape from SQLite (plugins stored as JSON string) */
export interface SnapshotRow {
  id: string;
  tenant: string;
  instance_id: string;
  user_id: string;
  name: string | null;
  type: string;
  s3_key: string | null;
  size_mb: number;
  size_bytes: number | null;
  node_id: string | null;
  trigger: string;
  plugins: string;
  config_hash: string;
  storage_path: string;
  created_at: string;
  expires_at: number | null;
  deleted_at: number | null;
}

/** Schema for creating a snapshot via the legacy API */
export const createSnapshotSchema = z.object({
  trigger: snapshotTriggerSchema.default("manual"),
});

/** Schema for creating an on-demand snapshot */
export const createOnDemandSnapshotSchema = z.object({
  name: z.string().max(128).optional(),
});

/** Convert a SQLite row to a Snapshot object */
export function rowToSnapshot(row: SnapshotRow): Snapshot {
  let plugins: string[] = [];
  try {
    plugins = JSON.parse(row.plugins) as string[];
  } catch {
    // Corrupted JSON -- fall back to empty array
  }

  return {
    id: row.id,
    tenant: row.tenant,
    instanceId: row.instance_id,
    userId: row.user_id,
    name: row.name ?? null,
    type: (row.type as "nightly" | "on-demand" | "pre-restore") ?? "on-demand",
    s3Key: row.s3_key ?? null,
    sizeMb: row.size_mb,
    sizeBytes: row.size_bytes ?? null,
    nodeId: row.node_id ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    deletedAt: row.deleted_at ?? null,
    trigger: row.trigger as SnapshotTrigger,
    plugins,
    configHash: row.config_hash,
    storagePath: row.storage_path,
  };
}
