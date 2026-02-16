/**
 * Repository Interface: BackupStatusRepository (ASYNC)
 *
 * Tracks backup status for containers.
 */
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
  isStale: boolean;
}

export interface BackupStatusRepository {
  /**
   * Record a successful backup for a container.
   */
  recordSuccess(containerId: string, nodeId: string, sizeMb: number, remotePath: string): Promise<void>;

  /**
   * Record a failed backup attempt for a container.
   */
  recordFailure(containerId: string, nodeId: string, error: string): Promise<void>;

  /**
   * Get backup status for a single container.
   */
  get(containerId: string): Promise<BackupStatusEntry | null>;

  /**
   * List all backup statuses, ordered by last backup time descending.
   */
  listAll(): Promise<BackupStatusEntry[]>;

  /**
   * List only stale backups (last successful backup > 24h ago or never backed up).
   */
  listStale(): Promise<BackupStatusEntry[]>;

  /**
   * Get count of all tracked containers.
   */
  count(): Promise<number>;
}
