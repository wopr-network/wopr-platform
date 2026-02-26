import { desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { backupStatus } from "../db/schema/backup-status.js";
import type { BackupStatusRow, IBackupStatusRepository } from "./repository-types.js";

export class DrizzleBackupStatusRepository implements IBackupStatusRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsertSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
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
      });
  }

  async upsertFailure(containerId: string, nodeId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
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
      });
  }

  async getByContainerId(containerId: string): Promise<BackupStatusRow | null> {
    const rows = await this.db.select().from(backupStatus).where(eq(backupStatus.containerId, containerId));
    return rows[0] ? toRow(rows[0]) : null;
  }

  async listAll(): Promise<BackupStatusRow[]> {
    const rows = await this.db.select().from(backupStatus).orderBy(desc(backupStatus.lastBackupAt));
    return rows.map(toRow);
  }

  async count(): Promise<number> {
    const rows = await this.db.select().from(backupStatus);
    return rows.length;
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
