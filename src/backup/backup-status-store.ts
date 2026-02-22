import type { BackupStatusRow, IBackupStatusRepository } from "./repository-types.js";

export interface BackupStatusEntry extends BackupStatusRow {
  /** Whether the backup is stale (>24h since last successful backup) */
  isStale: boolean;
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export class BackupStatusStore {
  private readonly repo: IBackupStatusRepository;

  constructor(repo: IBackupStatusRepository) {
    this.repo = repo;
  }

  /** Record a successful backup for a container. */
  recordSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): void {
    this.repo.upsertSuccess(containerId, nodeId, sizeMb, remotePath);
  }

  /** Record a failed backup attempt for a container. */
  recordFailure(containerId: string, nodeId: string, error: string): void {
    this.repo.upsertFailure(containerId, nodeId, error);
  }

  /** Get backup status for a single container. */
  get(containerId: string): BackupStatusEntry | null {
    const row = this.repo.getByContainerId(containerId);
    return row ? toEntry(row) : null;
  }

  /** List all backup statuses, ordered by last backup time descending. */
  listAll(): BackupStatusEntry[] {
    return this.repo.listAll().map(toEntry);
  }

  /** List only stale backups (last successful backup > 24h ago or never backed up). */
  listStale(): BackupStatusEntry[] {
    return this.listAll().filter((entry) => entry.isStale);
  }

  /** Get count of all tracked containers. */
  count(): number {
    return this.repo.count();
  }
}

function toEntry(row: BackupStatusRow): BackupStatusEntry {
  return {
    ...row,
    isStale: computeIsStale(row.lastBackupAt, row.lastBackupSuccess),
  };
}

function computeIsStale(lastBackupAt: string | null, lastBackupSuccess: boolean): boolean {
  if (!lastBackupAt || !lastBackupSuccess) return true;
  const elapsed = Date.now() - new Date(lastBackupAt).getTime();
  return elapsed > STALE_THRESHOLD_MS;
}
