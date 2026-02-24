/**
 * SOC 2 H7: Backup integrity verification.
 *
 * Verifies that backups stored in DO Spaces are readable and non-empty.
 * Runs on a scheduled basis (e.g., monthly) to detect silent backup corruption
 * before a real restore is needed.
 *
 * Verification is intentionally lightweight — it downloads the first 1 MB
 * of the archive and checks that it begins with a valid gzip/tar magic header
 * rather than doing a full restore (which would require a real Docker host).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { logger } from "../config/logger.js";
import type { SpacesClient } from "./spaces-client.js";

const GZIP_MAGIC_1 = 0x1f;
const GZIP_MAGIC_2 = 0x8b;
const MIN_VALID_SIZE_BYTES = 20; // An empty gzip is ~20 bytes; real archives are much larger

export interface BackupVerificationResult {
  key: string;
  valid: boolean;
  sizeMb: number;
  error?: string;
  verifiedAt: string;
}

export interface BackupVerificationReport {
  verifiedAt: string;
  totalChecked: number;
  passed: number;
  failed: number;
  results: BackupVerificationResult[];
}

/**
 * Verifies backup archives stored in DO Spaces by sampling recent backups
 * and checking their integrity (non-empty, valid gzip header, decompressible).
 */
export class BackupVerifier {
  private readonly spaces: SpacesClient;
  private readonly tempDir: string;

  constructor(opts: { spaces: SpacesClient; tempDir?: string }) {
    this.spaces = opts.spaces;
    this.tempDir = opts.tempDir ?? "/tmp/backup-verify";
  }

  /**
   * Verify backups under a given prefix.
   *
   * Lists objects under `prefix`, samples up to `limit` (default 10) of the
   * most recent ones, downloads each, and checks gzip header validity.
   *
   * @param prefix - DO Spaces prefix to list (e.g. "nightly/")
   * @param limit - Maximum number of backups to verify per run
   */
  async verify(prefix: string, limit = 10): Promise<BackupVerificationReport> {
    const verifiedAt = new Date().toISOString();
    await mkdir(this.tempDir, { recursive: true });

    let objects: Array<{ path: string; size: number; date: string }>;
    try {
      objects = await this.spaces.list(prefix);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`BackupVerifier: failed to list prefix ${prefix}`, { err: message });
      return { verifiedAt, totalChecked: 0, passed: 0, failed: 0, results: [] };
    }

    // Sort newest first, take up to limit
    objects.sort((a, b) => b.date.localeCompare(a.date));
    const sample = objects.slice(0, limit);

    const results: BackupVerificationResult[] = [];

    for (const obj of sample) {
      const result = await this.verifyOne(obj.path, obj.size);
      results.push(result);
    }

    const passed = results.filter((r) => r.valid).length;
    const failed = results.filter((r) => !r.valid).length;

    if (failed > 0) {
      logger.warn(`BackupVerifier: ${failed}/${results.length} backups failed verification under ${prefix}`, {
        prefix,
        failed: results.filter((r) => !r.valid).map((r) => r.key),
      });
    } else {
      logger.info(`BackupVerifier: all ${passed} sampled backups verified OK under ${prefix}`);
    }

    return { verifiedAt, totalChecked: results.length, passed, failed, results };
  }

  private async verifyOne(remotePath: string, remoteSize: number): Promise<BackupVerificationResult> {
    const filename = remotePath.replace(/\//g, "_");
    const localPath = join(this.tempDir, filename);
    const verifiedAt = new Date().toISOString();

    try {
      await this.spaces.download(remotePath, localPath);

      const info = await stat(localPath);
      const sizeMb = Math.round((info.size / (1024 * 1024)) * 100) / 100;

      if (info.size < MIN_VALID_SIZE_BYTES) {
        return { key: remotePath, valid: false, sizeMb, error: "Archive too small — likely corrupt", verifiedAt };
      }

      // Validate gzip magic bytes
      const { open } = await import("node:fs/promises");
      const fh = await open(localPath, "r");
      try {
        const buf = Buffer.alloc(2);
        await fh.read(buf, 0, 2, 0);
        if (buf[0] !== GZIP_MAGIC_1 || buf[1] !== GZIP_MAGIC_2) {
          return {
            key: remotePath,
            valid: false,
            sizeMb,
            error: `Invalid gzip header: 0x${buf[0].toString(16)}${buf[1].toString(16)}`,
            verifiedAt,
          };
        }
      } finally {
        await fh.close();
      }

      // Attempt to decompress (read-only stream, no write) to verify decompressibility
      await this.validateDecompressible(localPath);

      logger.debug(`BackupVerifier: ${remotePath} OK (${sizeMb}MB)`);
      return { key: remotePath, valid: true, sizeMb, verifiedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`BackupVerifier: ${remotePath} failed`, { err: message });
      return { key: remotePath, valid: false, sizeMb: remoteSize / (1024 * 1024), error: message, verifiedAt };
    } finally {
      await rm(localPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Attempt to stream-decompress the archive to detect corruption.
   * Reads up to 1 MB of compressed data to avoid excessive I/O on large archives.
   * Resolves if decompression succeeds; rejects on gzip error.
   */
  private async validateDecompressible(localPath: string): Promise<void> {
    const { createReadStream } = await import("node:fs");
    const MAX_COMPRESSED_BYTES = 1 * 1024 * 1024; // 1 MB sample

    await new Promise<void>((resolve, reject) => {
      const src = createReadStream(localPath, { end: MAX_COMPRESSED_BYTES - 1 });
      const gunzip = createGunzip();

      let settled = false;
      function done(err?: Error): void {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }

      gunzip.on("error", done);
      gunzip.on("end", () => done());
      gunzip.on("data", () => {}); // drain output
      src.on("error", done);

      src.pipe(gunzip);
    });
  }
}
