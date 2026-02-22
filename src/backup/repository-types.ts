// src/backup/repository-types.ts
//
// Plain TypeScript interfaces for all backup domain objects.
// No Drizzle types. No better-sqlite3. These are the contract
// the backup layer works against.

import type { Snapshot, SnapshotTrigger } from "./types.js";

// Re-export for convenience
export type { Snapshot, SnapshotTrigger };

// ---------------------------------------------------------------------------
// RestoreLog
// ---------------------------------------------------------------------------

export interface RestoreLogEntry {
  id: string;
  tenant: string;
  snapshotKey: string;
  preRestoreKey: string | null;
  restoredAt: number;
  restoredBy: string;
  reason: string | null;
}

export interface NewRestoreLogEntry {
  id: string;
  tenant: string;
  snapshotKey: string;
  preRestoreKey: string | null;
  restoredAt: number;
  restoredBy: string;
  reason: string | null;
}

export interface IRestoreLogRepository {
  insert(entry: NewRestoreLogEntry): void;
  getById(id: string): RestoreLogEntry | null;
  listByTenant(tenant: string, limit: number): RestoreLogEntry[];
}

// ---------------------------------------------------------------------------
// BackupStatus
// ---------------------------------------------------------------------------

/** Raw backup status from the database — no computed fields. */
export interface BackupStatusRow {
  containerId: string;
  nodeId: string;
  lastBackupAt: string | null;
  lastBackupSizeMb: number | null;
  lastBackupPath: string | null;
  lastBackupSuccess: boolean;
  lastBackupError: string | null;
  totalBackups: number;
  createdAt: string;
  updatedAt: string;
}

export interface IBackupStatusRepository {
  upsertSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): void;
  upsertFailure(containerId: string, nodeId: string, error: string): void;
  getByContainerId(containerId: string): BackupStatusRow | null;
  listAll(): BackupStatusRow[];
  count(): number;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface NewSnapshotRow {
  id: string;
  tenant: string;
  instanceId: string;
  userId: string;
  name: string | null;
  type: "nightly" | "on-demand" | "pre-restore";
  s3Key: string | null;
  sizeMb: number;
  sizeBytes: number;
  nodeId: string | null;
  trigger: SnapshotTrigger;
  plugins: string;
  configHash: string;
  storagePath: string;
  createdAt: string;
  expiresAt: number | null;
  deletedAt: number | null;
}

export interface ISnapshotRepository {
  insert(row: NewSnapshotRow): void;
  getById(id: string): Snapshot | null;
  list(instanceId: string, type?: string): Snapshot[];
  listByTenant(tenant: string, type?: string): Snapshot[];
  countByTenant(tenant: string, type: "on-demand"): number;
  listAllActive(type: "on-demand"): Snapshot[];
  listExpired(now: number): Snapshot[];
  softDelete(id: string): void;
  hardDelete(id: string): void;
  count(instanceId: string): number;
  getOldest(instanceId: string, limit: number): Snapshot[];
}
