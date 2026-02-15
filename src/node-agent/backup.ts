import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { logger } from "../config/logger.js";
import type { DockerManager } from "./docker.js";

const execFileAsync = promisify(execFile);

/**
 * Backup operations: export containers to tar.gz and upload/download via s3cmd.
 *
 * s3cmd is the ONLY child_process usage in the entire agent, and it's invoked
 * through execFile (not exec) with explicit argument arrays to prevent injection.
 */
export class BackupManager {
  private readonly dockerManager: DockerManager;
  private readonly backupDir: string;
  private readonly s3Bucket: string;

  constructor(dockerManager: DockerManager, backupDir: string, s3Bucket: string) {
    this.dockerManager = dockerManager;
    this.backupDir = backupDir;
    this.s3Bucket = s3Bucket;
  }

  /** Sanitize filename to prevent path traversal. */
  private safePath(filename: string): { localPath: string; safeName: string } {
    const safeName = basename(filename);
    const localPath = resolve(this.backupDir, safeName);
    if (!localPath.startsWith(resolve(this.backupDir))) {
      throw new Error(`Invalid filename: ${filename}`);
    }
    return { localPath, safeName };
  }

  /** Upload a local backup file to S3. */
  async upload(filename: string): Promise<void> {
    const { localPath, safeName } = this.safePath(filename);
    const s3Path = `s3://${this.s3Bucket}/${safeName}`;

    logger.info(`Uploading backup: ${localPath} -> ${s3Path}`);
    await execFileAsync("s3cmd", ["put", localPath, s3Path]);
    logger.info(`Upload complete: ${filename}`);
  }

  /** Download a backup file from S3. */
  async download(filename: string): Promise<void> {
    const { localPath, safeName } = this.safePath(filename);
    const s3Path = `s3://${this.s3Bucket}/${safeName}`;

    logger.info(`Downloading backup: ${s3Path} -> ${localPath}`);
    await execFileAsync("s3cmd", ["get", s3Path, localPath]);
    logger.info(`Download complete: ${filename}`);
  }

  /**
   * Run nightly backup for all tenant containers on this node.
   * Exports each container and uploads to S3.
   */
  async runNightly(): Promise<{ exported: string[]; failed: string[] }> {
    const containers = await this.dockerManager.listTenantContainers();
    const exported: string[] = [];
    const failed: string[] = [];

    for (const info of containers) {
      const name = info.Names[0]?.replace(/^\//, "");
      if (!name) continue;

      try {
        logger.info(`Nightly backup: exporting ${name}`);
        await this.dockerManager.exportBot(name, this.backupDir);

        const filename = `${name}.tar.gz`;
        await this.upload(filename);
        exported.push(name);
        logger.info(`Nightly backup: ${name} complete`);
      } catch (err) {
        logger.error(`Nightly backup: ${name} failed`, { err });
        failed.push(name);
      }
    }

    return { exported, failed };
  }
}

/**
 * Hot backup scheduler — runs every 6 hours, backs up only containers with changes.
 * Uses Docker SizeRw delta detection to skip unchanged containers.
 * Always overwrites latest/{containerName}/latest.tar.gz in S3.
 */
export class HotBackupScheduler {
  private readonly dockerManager: DockerManager;
  private readonly backupDir: string;
  private readonly s3Bucket: string;
  private readonly INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  private lastKnownSize = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dockerManager: DockerManager, backupDir: string, s3Bucket: string) {
    this.dockerManager = dockerManager;
    this.backupDir = backupDir;
    this.s3Bucket = s3Bucket;
  }

  /**
   * Check if container writable layer has changed since last backup.
   * Uses Docker SizeRw field (writable layer delta in bytes).
   */
  async shouldBackup(containerId: string): Promise<boolean> {
    try {
      const info = await this.dockerManager.docker.getContainer(containerId).inspect();
      // SizeRw is not in the official types but exists at runtime
      const sizeRw = (info as unknown as { SizeRw?: number }).SizeRw ?? 0;
      const lastSize = this.lastKnownSize.get(containerId) ?? -1;

      if (sizeRw === lastSize) {
        return false; // No changes
      }

      this.lastKnownSize.set(containerId, sizeRw);
      return true;
    } catch (err) {
      logger.warn(`Failed to inspect container ${containerId}`, { err });
      return true; // Default to backing up if we can't determine
    }
  }

  /**
   * Run hot backup: export changed containers, overwrite latest/{tenant}/latest.tar.gz
   */
  async runHotBackup(): Promise<{ backed_up: string[]; skipped: string[]; failed: string[] }> {
    const containers = await this.dockerManager.listTenantContainers();
    const backed_up: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    logger.info(`Hot backup: checking ${containers.length} containers`);

    for (const info of containers) {
      const name = info.Names[0]?.replace(/^\//, "");
      const id = info.Id;
      if (!name || !id) continue;

      try {
        // Check if container has changed
        if (!(await this.shouldBackup(id))) {
          logger.debug(`Hot backup: ${name} unchanged, skipping`);
          skipped.push(name);
          continue;
        }

        logger.info(`Hot backup: exporting ${name}`);
        await this.dockerManager.exportBot(name, this.backupDir);

        // Upload with s3cmd, overwriting latest/{name}/latest.tar.gz
        const localPath = resolve(this.backupDir, `${name}.tar.gz`);
        const s3Path = `s3://${this.s3Bucket}/latest/${name}/latest.tar.gz`;

        await execFileAsync("s3cmd", ["put", "--force", localPath, s3Path]);

        backed_up.push(name);
        logger.info(`Hot backup: ${name} complete → ${s3Path}`);
      } catch (err) {
        logger.error(`Hot backup: ${name} failed`, { err });
        failed.push(name);
      }
    }

    logger.info(
      `Hot backup complete: ${backed_up.length} backed up, ${skipped.length} skipped, ${failed.length} failed`,
    );

    return { backed_up, skipped, failed };
  }

  /** Start the 6-hour hot backup timer */
  start(): void {
    if (this.timer) {
      logger.warn("Hot backup scheduler already running");
      return;
    }

    logger.info("Starting hot backup scheduler (6 hour interval)");

    // Run first backup immediately
    this.runHotBackup().catch((err) => {
      logger.error("Initial hot backup failed", { err });
    });

    // Then schedule every 6 hours
    this.timer = setInterval(() => {
      this.runHotBackup().catch((err) => {
        logger.error("Scheduled hot backup failed", { err });
      });
    }, this.INTERVAL_MS);
  }

  /** Stop the hot backup timer */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Hot backup scheduler stopped");
    }
  }
}
