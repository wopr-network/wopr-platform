import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../config/logger.js";

const execFileAsync = promisify(execFile);

/**
 * S3-compatible client for DigitalOcean Spaces.
 *
 * Uses s3cmd (already installed on node-agent images) with explicit argument
 * arrays via execFile to prevent command injection.
 */
export class SpacesClient {
  private readonly bucket: string;

  constructor(bucket: string) {
    this.bucket = bucket;
  }

  /** Upload a local file to a Spaces path. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const s3Path = `s3://${this.bucket}/${remotePath}`;
    logger.info(`Spaces upload: ${localPath} -> ${s3Path}`);
    await execFileAsync("s3cmd", ["put", localPath, s3Path]);
  }

  /** Download a file from Spaces to a local path. */
  async download(remotePath: string, localPath: string): Promise<void> {
    const s3Path = `s3://${this.bucket}/${remotePath}`;
    logger.info(`Spaces download: ${s3Path} -> ${localPath}`);
    await execFileAsync("s3cmd", ["get", s3Path, localPath, "--force"]);
  }

  /** List objects under a prefix. Returns array of {path, size, date} entries. */
  async list(prefix: string): Promise<SpacesObject[]> {
    const s3Path = `s3://${this.bucket}/${prefix}`;
    try {
      const { stdout } = await execFileAsync("s3cmd", ["ls", s3Path]);
      return parseS3CmdLsOutput(stdout);
    } catch {
      // Empty prefix or access error
      return [];
    }
  }

  /** Delete a remote object. */
  async remove(remotePath: string): Promise<void> {
    const s3Path = `s3://${this.bucket}/${remotePath}`;
    logger.info(`Spaces delete: ${s3Path}`);
    await execFileAsync("s3cmd", ["del", s3Path]);
  }

  /** Delete multiple remote objects. */
  async removeMany(remotePaths: string[]): Promise<void> {
    if (remotePaths.length === 0) return;
    const s3Paths = remotePaths.map((p) => `s3://${this.bucket}/${p}`);
    logger.info(`Spaces bulk delete: ${s3Paths.length} objects`);
    await execFileAsync("s3cmd", ["del", ...s3Paths]);
  }
}

export interface SpacesObject {
  date: string;
  size: number;
  path: string;
}

/**
 * Parse s3cmd ls output.
 * Format: "2026-02-14 03:00    12345   s3://bucket/path/to/file.tar.gz"
 */
export function parseS3CmdLsOutput(stdout: string): SpacesObject[] {
  const results: SpacesObject[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // s3cmd ls output: DATE TIME SIZE s3://bucket/path
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\d+)\s+s3:\/\/[^/]+\/(.+)$/);
    if (match) {
      results.push({
        date: `${match[1]}T${match[2]}:00Z`,
        size: Number.parseInt(match[3], 10),
        path: match[4],
      });
    }
  }
  return results;
}
