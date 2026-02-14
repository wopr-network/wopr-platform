import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { asc, count, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { logger } from "../config/logger.js";
import { snapshots } from "../db/schema/snapshots.js";
import type { Snapshot, SnapshotTrigger } from "./types.js";
import { rowToSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

/** Only allow safe characters in IDs used for filesystem paths. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface SnapshotManagerOptions {
  /** Directory where snapshot tar files are stored */
  snapshotDir: string;
  /** Drizzle database instance */
  db: BetterSQLite3Database<Record<string, unknown>>;
}

export class SnapshotManager {
  private readonly snapshotDir: string;
  private readonly db: BetterSQLite3Database<Record<string, unknown>>;

  constructor(opts: SnapshotManagerOptions) {
    this.snapshotDir = opts.snapshotDir;
    this.db = opts.db;
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
    if (!SAFE_ID_RE.test(params.instanceId)) {
      throw new Error(`Invalid instanceId: ${params.instanceId}`);
    }

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

    // Store metadata in SQLite -- clean up tar if insert fails
    try {
      this.db
        .insert(snapshots)
        .values({
          id,
          instanceId: params.instanceId,
          userId: params.userId,
          createdAt,
          sizeMb,
          trigger: params.trigger,
          plugins: JSON.stringify(plugins),
          configHash,
          storagePath: tarPath,
        })
        .run();
    } catch (err) {
      await rm(tarPath, { force: true });
      throw err;
    }

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
    } catch (err: unknown) {
      // WOPR_HOME doesn't exist yet -- that's OK; anything else is a real failure
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    try {
      await mkdir(woprHomePath, { recursive: true });

      // Extract snapshot directly into woprHomePath, stripping the original basename
      await execFileAsync("tar", ["-xzf", snapshot.storagePath, "-C", woprHomePath, "--strip-components=1"]);

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
    const row = this.db.select().from(snapshots).where(eq(snapshots.id, id)).get();
    return row ? rowToSnapshot(mapDrizzleRow(row)) : null;
  }

  /** List all snapshots for an instance, newest first */
  list(instanceId: string): Snapshot[] {
    const rows = this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.instanceId, instanceId))
      .orderBy(desc(snapshots.createdAt))
      .all();
    return rows.map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  /** Delete a snapshot: remove tar file and metadata */
  async delete(id: string): Promise<boolean> {
    const snapshot = this.get(id);
    if (!snapshot) return false;

    // Remove tar file
    await rm(snapshot.storagePath, { force: true });

    // Remove metadata
    this.db.delete(snapshots).where(eq(snapshots.id, id)).run();

    logger.info(`Deleted snapshot ${id}`);
    return true;
  }

  /** Count snapshots for an instance */
  count(instanceId: string): number {
    const row = this.db.select({ cnt: count() }).from(snapshots).where(eq(snapshots.instanceId, instanceId)).get();
    return row?.cnt ?? 0;
  }

  /** Get oldest snapshots for an instance (for retention cleanup) */
  getOldest(instanceId: string, limit: number): Snapshot[] {
    const rows = this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.instanceId, instanceId))
      .orderBy(asc(snapshots.createdAt))
      .limit(limit)
      .all();
    return rows.map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }
}

/** Map Drizzle camelCase row to the SnapshotRow interface (snake_case). */
function mapDrizzleRow(row: typeof snapshots.$inferSelect) {
  return {
    id: row.id,
    instance_id: row.instanceId,
    user_id: row.userId,
    created_at: row.createdAt,
    size_mb: row.sizeMb,
    trigger: row.trigger,
    plugins: row.plugins,
    config_hash: row.configHash,
    storage_path: row.storagePath,
  };
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
