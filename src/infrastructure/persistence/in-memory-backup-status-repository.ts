import type { BackupStatusEntry, BackupStatusRepository } from "../../domain/repositories/backup-status-repository.js";

export class InMemoryBackupStatusRepository implements BackupStatusRepository {
  private readonly statuses = new Map<string, BackupStatusEntry>();

  async recordSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.statuses.get(containerId);

    this.statuses.set(containerId, {
      containerId,
      nodeId,
      lastBackupAt: now,
      lastBackupSizeMb: sizeMb,
      lastBackupPath: remotePath,
      lastBackupSuccess: true,
      lastBackupError: null,
      totalBackups: (existing?.totalBackups ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      isStale: false,
    });
  }

  async recordFailure(containerId: string, nodeId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.statuses.get(containerId);

    this.statuses.set(containerId, {
      containerId,
      nodeId,
      lastBackupAt: existing?.lastBackupAt ?? null,
      lastBackupSizeMb: existing?.lastBackupSizeMb ?? null,
      lastBackupPath: existing?.lastBackupPath ?? null,
      lastBackupSuccess: false,
      lastBackupError: error,
      totalBackups: existing?.totalBackups ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      isStale: true,
    });
  }

  async get(containerId: string): Promise<BackupStatusEntry | null> {
    return this.statuses.get(containerId) ?? null;
  }

  async listAll(): Promise<BackupStatusEntry[]> {
    return Array.from(this.statuses.values()).sort((a, b) => {
      const aTime = a.lastBackupAt ?? "";
      const bTime = b.lastBackupAt ?? "";
      return bTime.localeCompare(aTime);
    });
  }

  async listStale(): Promise<BackupStatusEntry[]> {
    const all = await this.listAll();
    return all.filter((entry) => entry.isStale);
  }

  async count(): Promise<number> {
    return this.statuses.size;
  }

  reset(): void {
    this.statuses.clear();
  }
}
