import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { logger } from "../config/logger.js";
import { initSnapshotSchema } from "./schema.js";
import type { Snapshot, SnapshotRow, SnapshotTrigger } from "./types.js";
import { rowToSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

export interface SnapshotManagerOptions {
  /** Directory where snapshot tar files are stored */
  snapshotDir: string;
  /** SQLite database for metadata */
  db: Database.Database;
}

export class SnapshotManager {
  private readonly snapshotDir: string;
  private readonly db: Database.Database;

  constructor(opts: SnapshotManagerOptions) {
    this.snapshotDir = opts.snapshotDir;
    this.db = opts.db;
    initSnapshotSchema(this.db);
  }

  /**
   * Create a snapshot of an instance's WOPR_HOME directory.
   *
   * 1. Tar the WOPR_HOME directory
   * 2. Store metadata in SQLite
   * 3. Return the snapshot record
   */
  async create(params: {
    instanceId: string;
    userId: string;
    woprHomePath: string;
    trigger: SnapshotTrigger;
    plugins?: string[];
  }): Promise<Snapshot> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const tarPath = join(this.snapshotDir, params.instanceId, `${id}.tar.gz`);

    await mkdir(dirname(tarPath), { recursive: true });

    // Compute config hash if config.json exists
    let configHash = "";
    try {
      const configPath = join(params.woprHomePath, "config.json");
      const configContent = await readFile(configPath, "utf-8");
      configHash = createHash("sha256").update(configContent).digest("hex");
    } catch {
      // No config.json or unreadable -- that's fine
    }

    // Tar the WOPR_HOME directory
    await execFileAsync("tar", [
      "-czf",
      tarPath,
      "-C",
      dirname(params.woprHomePath),
      // tar the basename only so extraction is relative
      getBasename(params.woprHomePath),
    ]);

    // Get file size
    const info = await stat(tarPath);
    const sizeMb = Math.round((info.size / (1024 * 1024)) * 100) / 100;

    const plugins = params.plugins ?? [];

    // Store metadata in SQLite
    this.db
      .prepare(
        `INSERT INTO snapshots (id, instance_id, user_id, created_at, size_mb, trigger, plugins, config_hash, storage_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.instanceId,
        params.userId,
        createdAt,
        sizeMb,
        params.trigger,
        JSON.stringify(plugins),
        configHash,
        tarPath,
      );

    logger.info(`Snapshot ${id} created for instance ${params.instanceId} (${sizeMb}MB)`);

    return {
      id,
      instanceId: params.instanceId,
      userId: params.userId,
      createdAt,
      sizeMb,
      trigger: params.trigger,
      plugins,
      configHash,
      storagePath: tarPath,
    };
  }

  /**
   * Restore an instance from a snapshot.
   *
   * 1. Back up current WOPR_HOME as safety net
   * 2. Extract snapshot tar over WOPR_HOME
   */
  async restore(snapshotId: string, woprHomePath: string): Promise<void> {
    const snapshot = this.get(snapshotId);
    if (!snapshot) {
      throw new SnapshotNotFoundError(snapshotId);
    }

    // Safety backup: rename current WOPR_HOME
    const backupPath = `${woprHomePath}.pre-restore-${Date.now()}`;
    try {
      await rename(woprHomePath, backupPath);
    } catch {
      // WOPR_HOME doesn't exist yet, that's OK
    }

    try {
      await mkdir(woprHomePath, { recursive: true });

      // Extract the snapshot tar into the parent directory
      await execFileAsync("tar", ["-xzf", snapshot.storagePath, "-C", dirname(woprHomePath)]);

      logger.info(`Restored snapshot ${snapshotId} to ${woprHomePath}`);

      // Clean up the safety backup on success
      await rm(backupPath, { recursive: true, force: true });
    } catch (err) {
      // Restore failed -- put the original back
      logger.error(`Restore of snapshot ${snapshotId} failed, rolling back`, { err });
      await rm(woprHomePath, { recursive: true, force: true });
      try {
        await rename(backupPath, woprHomePath);
      } catch {
        // backup might not exist
      }
      throw err;
    }
  }

  /** Get a single snapshot by ID */
  get(id: string): Snapshot | null {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** List all snapshots for an instance, newest first */
  list(instanceId: string): Snapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM snapshots WHERE instance_id = ? ORDER BY created_at DESC")
      .all(instanceId) as SnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  /** Delete a snapshot: remove tar file and metadata */
  async delete(id: string): Promise<boolean> {
    const snapshot = this.get(id);
    if (!snapshot) return false;

    // Remove tar file
    await rm(snapshot.storagePath, { force: true });

    // Remove metadata
    this.db.prepare("DELETE FROM snapshots WHERE id = ?").run(id);

    logger.info(`Deleted snapshot ${id}`);
    return true;
  }

  /** Count snapshots for an instance */
  count(instanceId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM snapshots WHERE instance_id = ?").get(instanceId) as {
      cnt: number;
    };
    return row.cnt;
  }

  /** Get oldest snapshots for an instance (for retention cleanup) */
  getOldest(instanceId: string, limit: number): Snapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM snapshots WHERE instance_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(instanceId, limit) as SnapshotRow[];
    return rows.map(rowToSnapshot);
  }
}

/** Extract the last path segment (works with or without trailing slash) */
function getBasename(p: string): string {
  const segments = p.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1];
}

export class SnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`Snapshot not found: ${id}`);
    this.name = "SnapshotNotFoundError";
  }
}
