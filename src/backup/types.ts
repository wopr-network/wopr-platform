import { z } from "zod";

/** Trigger types for snapshot creation */
export const snapshotTriggerSchema = z.enum(["manual", "scheduled", "pre_update"]);
export type SnapshotTrigger = z.infer<typeof snapshotTriggerSchema>;

/** Subscription tiers with backup capabilities */
export const tierSchema = z.enum(["free", "pro", "team", "enterprise"]);
export type Tier = z.infer<typeof tierSchema>;

/** Snapshot metadata stored in SQLite */
export interface Snapshot {
  id: string;
  instanceId: string;
  userId: string;
  createdAt: string;
  sizeMb: number;
  trigger: SnapshotTrigger;
  plugins: string[];
  configHash: string;
  storagePath: string;
}

/** Row shape from SQLite (plugins stored as JSON string) */
export interface SnapshotRow {
  id: string;
  instance_id: string;
  user_id: string;
  created_at: string;
  size_mb: number;
  trigger: string;
  plugins: string;
  config_hash: string;
  storage_path: string;
}

/** Tier-based retention policy */
export interface RetentionPolicy {
  maxSnapshots: number;
  autoSchedule: "none" | "daily" | "hourly" | "configurable";
}

/** Retention policies per tier */
export const RETENTION_POLICIES: Record<Tier, RetentionPolicy> = {
  free: { maxSnapshots: 3, autoSchedule: "none" },
  pro: { maxSnapshots: 7, autoSchedule: "daily" },
  team: { maxSnapshots: 720, autoSchedule: "hourly" }, // ~30 days of hourly
  enterprise: { maxSnapshots: Number.MAX_SAFE_INTEGER, autoSchedule: "configurable" },
};

/** Schema for creating a snapshot via API */
export const createSnapshotSchema = z.object({
  trigger: snapshotTriggerSchema.default("manual"),
});

/** Convert a SQLite row to a Snapshot object */
export function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    instanceId: row.instance_id,
    userId: row.user_id,
    createdAt: row.created_at,
    sizeMb: row.size_mb,
    trigger: row.trigger as SnapshotTrigger,
    plugins: JSON.parse(row.plugins) as string[],
    configHash: row.config_hash,
    storagePath: row.storage_path,
  };
}
