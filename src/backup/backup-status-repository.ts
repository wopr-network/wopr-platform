import { desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { backupStatus } from "../db/schema/backup-status.js";
import type { BackupStatusRow, IBackupStatusRepository } from "./repository-types.js";

export class DrizzleBackupStatusRepository implements IBackupStatusRepository {
  constructor(private readonly db: DrizzleDb) {}

  upsertSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): void {
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

  upsertFailure(containerId: string, nodeId: string, error: string): void {
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

  getByContainerId(containerId: string): BackupStatusRow | null {
    const row = this.db.select().from(backupStatus).where(eq(backupStatus.containerId, containerId)).get();
    return row ? toRow(row) : null;
  }

  listAll(): BackupStatusRow[] {
    return this.db.select().from(backupStatus).orderBy(desc(backupStatus.lastBackupAt)).all().map(toRow);
  }

  count(): number {
    return this.db.select().from(backupStatus).all().length;
  }
}

function toRow(row: typeof backupStatus.$inferSelect): BackupStatusRow {
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
  };
}
