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
