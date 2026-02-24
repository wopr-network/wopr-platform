import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../config/logger.js";
import type { DockerManager } from "../node-agent/docker.js";
import type { SpacesClient } from "./spaces-client.js";

export interface NightlyBackupOptions {
  /** Docker manager for container operations */
  docker: DockerManager;
  /** DO Spaces client */
  spaces: SpacesClient;
  /** Local directory for temporary backup files */
  backupDir: string;
  /** Node hostname/identifier */
  nodeId: string;
}

export interface BackupResult {
  container: string;
  success: boolean;
  sizeMb?: number;
  remotePath?: string;
  error?: string;
}

export interface NightlyBackupReport {
  nodeId: string;
  date: string;
  startedAt: string;
  completedAt: string;
  results: BackupResult[];
  exported: string[];
  failed: string[];
}

/**
 * Nightly backup orchestrator.
 *
 * For each tenant container on this node:
 * 1. Export the running container (does NOT stop it)
 * 2. Upload compressed archive to DO Spaces
 * 3. Clean up local temporary file
 *
 * Path format: nightly/{nodeId}/{containerName}/{containerName}_{YYYYMMDD}.tar.gz
 */
export class NightlyBackup {
  private readonly docker: DockerManager;
  private readonly spaces: SpacesClient;
  private readonly backupDir: string;
  private readonly nodeId: string;

  constructor(opts: NightlyBackupOptions) {
    this.docker = opts.docker;
    this.spaces = opts.spaces;
    this.backupDir = opts.backupDir;
    this.nodeId = opts.nodeId;
  }

  /** Run nightly backup for all tenant containers on this node. */
  async run(): Promise<NightlyBackupReport> {
    const date = formatDate(new Date());
    const startedAt = new Date().toISOString();

    await mkdir(this.backupDir, { recursive: true });

    const containers = await this.docker.listTenantContainers();
    const results: BackupResult[] = [];

    for (const info of containers) {
      const name = info.Names[0]?.replace(/^\//, "");
      if (!name) continue;

      const result = await this.backupContainer(name, date);
      results.push(result);
    }

    const exported = results.filter((r) => r.success).map((r) => r.container);
    const failed = results.filter((r) => !r.success).map((r) => r.container);

    const report: NightlyBackupReport = {
      nodeId: this.nodeId,
      date,
      startedAt,
      completedAt: new Date().toISOString(),
      results,
      exported,
      failed,
    };

    logger.info(`Nightly backup complete: ${exported.length} exported, ${failed.length} failed`, {
      nodeId: this.nodeId,
      date,
    });

    return report;
  }

  /** Backup a single container: export -> upload -> cleanup. */
  private async backupContainer(name: string, date: string): Promise<BackupResult> {
    const localPath = join(this.backupDir, `${name}_${date}.tar.gz`);
    const remotePath = `nightly/${this.nodeId}/${name}/${name}_${date}.tar.gz`;

    try {
      logger.info(`Backing up container: ${name}`);

      // Export running container (docker export works without stopping)
      await this.docker.exportBot(name, this.backupDir);

      // The exportBot method creates {name}.tar.gz in backupDir
      const exportedPath = join(this.backupDir, `${name}.tar.gz`);

      // Rename to include date
      const { rename } = await import("node:fs/promises");
      await rename(exportedPath, localPath);

      // Encrypt before upload if BACKUP_ENCRYPTION_KEY is set
      const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
      let uploadPath = localPath;
      let uploadRemotePath = remotePath;
      if (encryptionKey) {
        const { encryptFile } = await import("./encrypt-archive.js");
        const encryptedPath = `${localPath}.enc`;
        await encryptFile(localPath, encryptedPath, encryptionKey);
        await rm(localPath, { force: true }); // Remove unencrypted
        uploadPath = encryptedPath;
        uploadRemotePath = `${remotePath}.enc`;
      }

      // Get file size
      const info = await stat(uploadPath);
      const sizeMb = Math.round((info.size / (1024 * 1024)) * 100) / 100;

      // Upload to DO Spaces
      await this.spaces.upload(uploadPath, uploadRemotePath);

      // Clean up local file
      await rm(uploadPath, { force: true });

      logger.info(`Backup complete: ${name} (${sizeMb}MB)`);
      return { container: name, success: true, sizeMb, remotePath: uploadRemotePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Backup failed: ${name}`, { err: message });

      // Clean up on failure
      await rm(localPath, { force: true }).catch(() => {});

      return { container: name, success: false, error: message };
    }
  }
}

/** Format a date as YYYYMMDD (UTC) */
export function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
