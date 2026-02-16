import { desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { backupStatus } from "../../db/schema/backup-status.js";
import type { BackupStatusEntry, BackupStatusRepository } from "../../domain/repositories/backup-status-repository.js";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export class DrizzleBackupStatusRepository implements BackupStatusRepository {
  constructor(private readonly db: BetterSQLite3Database<Record<string, unknown>>) {}

  async recordSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): Promise<void> {
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

  async recordFailure(containerId: string, nodeId: string, error: string): Promise<void> {
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

  async get(containerId: string): Promise<BackupStatusEntry | null> {
    const row = this.db.select().from(backupStatus).where(eq(backupStatus.containerId, containerId)).get();
    return row ? toEntry(row) : null;
  }

  async listAll(): Promise<BackupStatusEntry[]> {
    const rows = this.db.select().from(backupStatus).orderBy(desc(backupStatus.lastBackupAt)).all();
    return rows.map(toEntry);
  }

  async listStale(): Promise<BackupStatusEntry[]> {
    const all = await this.listAll();
    return all.filter((entry) => entry.isStale);
  }

  async count(): Promise<number> {
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
