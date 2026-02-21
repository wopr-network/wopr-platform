import { desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { backupStatus } from "../db/schema/backup-status.js";

export interface BackupStatusEntry {
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
  /** Whether the backup is stale (>24h since last successful backup) */
  isStale: boolean;
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export class BackupStatusStore {
  private readonly db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  /** Record a successful backup for a container. */
  recordSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): void {
    const now = new Date().toISOString();

    this.db
      .insert(backupStatus)
      .values({
        containerId,
        nodeId,
        lastBackupAt: now,
        lastBackupSizeMb: sizeMb,
        lastBackupPath: remotePath,
        lastBackupSuccess: true,
        lastBackupError: null,
        totalBackups: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: backupStatus.containerId,
        set: {
          nodeId,
          lastBackupAt: now,
          lastBackupSizeMb: sizeMb,
          lastBackupPath: remotePath,
          lastBackupSuccess: true,
          lastBackupError: null,
          totalBackups: sql`${backupStatus.totalBackups} + 1`,
          updatedAt: now,
        },
      })
      .run();
  }

  /** Record a failed backup attempt for a container. */
  recordFailure(containerId: string, nodeId: string, error: string): void {
    const now = new Date().toISOString();

    this.db
      .insert(backupStatus)
      .values({
        containerId,
        nodeId,
        lastBackupSuccess: false,
        lastBackupError: error,
        totalBackups: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: backupStatus.containerId,
        set: {
          lastBackupSuccess: false,
          lastBackupError: error,
          updatedAt: now,
        },
      })
      .run();
  }

  /** Get backup status for a single container. */
  get(containerId: string): BackupStatusEntry | null {
    const row = this.db.select().from(backupStatus).where(eq(backupStatus.containerId, containerId)).get();
    return row ? toEntry(row) : null;
  }

  /** List all backup statuses, ordered by last backup time descending. */
  listAll(): BackupStatusEntry[] {
    const rows = this.db.select().from(backupStatus).orderBy(desc(backupStatus.lastBackupAt)).all();
    return rows.map(toEntry);
  }

  /** List only stale backups (last successful backup > 24h ago or never backed up). */
  listStale(): BackupStatusEntry[] {
    return this.listAll().filter((entry) => entry.isStale);
  }

  /** Get count of all tracked containers. */
  count(): number {
    const rows = this.db.select().from(backupStatus).all();
    return rows.length;
  }
}

function toEntry(row: typeof backupStatus.$inferSelect): BackupStatusEntry {
  const isStale = computeIsStale(row.lastBackupAt, row.lastBackupSuccess);
  return {
    containerId: row.containerId,
    nodeId: row.nodeId,
    lastBackupAt: row.lastBackupAt,
    lastBackupSizeMb: row.lastBackupSizeMb,
    lastBackupPath: row.lastBackupPath,
    lastBackupSuccess: row.lastBackupSuccess,
    lastBackupError: row.lastBackupError,
    totalBackups: row.totalBackups,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isStale,
  };
}

function computeIsStale(lastBackupAt: string | null, lastBackupSuccess: boolean): boolean {
  if (!lastBackupAt || !lastBackupSuccess) return true;
  const elapsed = Date.now() - new Date(lastBackupAt).getTime();
  return elapsed > STALE_THRESHOLD_MS;
}
