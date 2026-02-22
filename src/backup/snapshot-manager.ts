import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../config/logger.js";
import type { ISnapshotRepository, NewSnapshotRow } from "./repository-types.js";
import type { SpacesClient } from "./spaces-client.js";
import type { Snapshot, SnapshotTrigger } from "./types.js";

const execFileAsync = promisify(execFile);

/** Only allow safe characters in IDs used for filesystem paths. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface SnapshotManagerOptions {
  /** Directory where snapshot tar files are stored */
  snapshotDir: string;
  /** Snapshot repository */
  repo: ISnapshotRepository;
  /** Optional DO Spaces client for remote upload */
  spaces?: SpacesClient;
}

export class SnapshotManager {
  private readonly snapshotDir: string;
  private readonly repo: ISnapshotRepository;
  private readonly spaces?: SpacesClient;

  constructor(opts: SnapshotManagerOptions) {
    this.snapshotDir = opts.snapshotDir;
    this.repo = opts.repo;
    this.spaces = opts.spaces;
  }

  /**
   * Create a snapshot of an instance's WOPR_HOME directory.
   *
   * 1. Tar the WOPR_HOME directory
   * 2. Optionally upload to DO Spaces
   * 3. Store metadata in SQLite
   * 4. Return the snapshot record
   */
  async create(params: {
    instanceId: string;
    userId: string;
    woprHomePath: string;
    trigger: SnapshotTrigger;
    plugins?: string[];
    tenant?: string;
    name?: string;
    type?: "nightly" | "on-demand" | "pre-restore";
    nodeId?: string;
    expiresAt?: number;
  }): Promise<Snapshot> {
    if (!SAFE_ID_RE.test(params.instanceId)) {
      throw new Error(`Invalid instanceId: ${params.instanceId}`);
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const snapshotType = params.type ?? "on-demand";
    const tenant = params.tenant ?? "";
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
    const sizeBytes = info.size;

    const plugins = params.plugins ?? [];

    // Optionally upload to DO Spaces
    let s3Key: string | null = null;
    if (this.spaces) {
      try {
        if (snapshotType === "on-demand") {
          const namePart = params.name ? `_${params.name}` : "";
          s3Key = `on-demand/${tenant}/${id}${namePart}.tar.gz`;
        } else if (snapshotType === "nightly") {
          const dateStr = new Date().toISOString().slice(0, 10);
          s3Key = `nightly/${params.nodeId ?? "unknown"}/${tenant}/${tenant}_${dateStr}.tar.gz`;
        } else if (snapshotType === "pre-restore") {
          s3Key = `pre-restore/${tenant}/${tenant}_pre_restore.tar.gz`;
        }
        if (s3Key) {
          await this.spaces.upload(tarPath, s3Key);
        }
      } catch (err) {
        logger.warn(`Spaces upload failed for snapshot ${id}, continuing with local only`, {
          err: err instanceof Error ? err.message : String(err),
        });
        s3Key = null;
      }
    }

    // Store metadata in DB -- clean up tar if insert fails
    const row: NewSnapshotRow = {
      id,
      tenant,
      instanceId: params.instanceId,
      userId: params.userId,
      name: params.name ?? null,
      type: snapshotType,
      s3Key,
      sizeMb,
      sizeBytes,
      nodeId: params.nodeId ?? null,
      trigger: params.trigger,
      plugins: JSON.stringify(plugins),
      configHash,
      storagePath: tarPath,
      createdAt,
      expiresAt: params.expiresAt ?? null,
      deletedAt: null,
    };

    try {
      this.repo.insert(row);
    } catch (err) {
      await rm(tarPath, { force: true });
      // Clean up orphaned S3 object if upload succeeded but DB insert failed
      if (this.spaces && s3Key) {
        try {
          await this.spaces.remove(s3Key);
        } catch (cleanupErr) {
          logger.warn(`Failed to clean up orphaned S3 object ${s3Key} after DB insert failure`, {
            err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      throw err;
    }

    logger.info(`Snapshot ${id} created for instance ${params.instanceId} (${sizeMb}MB, type=${snapshotType})`);

    return {
      id,
      tenant,
      instanceId: params.instanceId,
      userId: params.userId,
      name: params.name ?? null,
      type: snapshotType,
      s3Key,
      sizeMb,
      sizeBytes,
      nodeId: params.nodeId ?? null,
      createdAt,
      expiresAt: params.expiresAt ?? null,
      deletedAt: null,
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
    return this.repo.getById(id);
  }

  /** List all non-deleted snapshots for an instance, newest first */
  list(instanceId: string, type?: string): Snapshot[] {
    return this.repo.list(instanceId, type);
  }

  /** List all non-deleted snapshots for a tenant */
  listByTenant(tenant: string, type?: string): Snapshot[] {
    return this.repo.listByTenant(tenant, type);
  }

  /** Count on-demand snapshots for a tenant (non-deleted only) */
  countByTenant(tenant: string, type: "on-demand"): number {
    return this.repo.countByTenant(tenant, type);
  }

  /** List all active (non-deleted) snapshots of a given type across all tenants */
  listAllActive(type: "on-demand"): Snapshot[] {
    return this.repo.listAllActive(type);
  }

  /** List snapshots that have passed their expiresAt time */
  listExpired(now: number): Snapshot[] {
    return this.repo.listExpired(now);
  }

  /**
   * Soft-delete a snapshot: set deletedAt timestamp.
   * Also removes from DO Spaces if s3Key is set.
   *
   * If Spaces removal succeeds but the DB update fails, the S3 object is
   * already gone. In that case we log the orphaned key for manual
   * reconciliation and re-throw so the caller knows the delete failed.
   */
  async delete(id: string): Promise<boolean> {
    const snapshot = this.get(id);
    if (!snapshot) return false;

    // Remove from DO Spaces if available
    let spacesRemoved = false;
    if (this.spaces && snapshot.s3Key) {
      try {
        await this.spaces.remove(snapshot.s3Key);
        spacesRemoved = true;
      } catch (err) {
        logger.warn(`Failed to remove snapshot ${id} from Spaces (s3Key=${snapshot.s3Key})`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Soft-delete in DB
    try {
      this.repo.softDelete(id);
    } catch (err) {
      if (spacesRemoved && snapshot.s3Key) {
        // S3 object is already deleted but DB record is still active — log for manual reconciliation
        logger.error(
          `Orphaned Spaces object after DB soft-delete failure: snapshotId=${id} s3Key=${snapshot.s3Key} — manual reconciliation required`,
          { err: err instanceof Error ? err.message : String(err) },
        );
      }
      throw err;
    }

    logger.info(`Soft-deleted snapshot ${id}`);
    return true;
  }

  /** Hard-delete a snapshot: remove tar file, Spaces object, and DB row. */
  async hardDelete(id: string): Promise<boolean> {
    const snapshot = this.get(id);
    if (!snapshot) return false;

    // Remove tar file
    await rm(snapshot.storagePath, { force: true });

    // Remove from DO Spaces if available
    if (this.spaces && snapshot.s3Key) {
      try {
        await this.spaces.remove(snapshot.s3Key);
      } catch (err) {
        logger.warn(`Failed to remove expired snapshot ${id} from Spaces`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Hard-delete from DB
    this.repo.hardDelete(id);

    logger.info(`Hard-deleted snapshot ${id}`);
    return true;
  }

  /** Count non-deleted snapshots for an instance */
  count(instanceId: string): number {
    return this.repo.count(instanceId);
  }

  /** Get oldest non-deleted snapshots for an instance (for retention cleanup) */
  getOldest(instanceId: string, limit: number): Snapshot[] {
    return this.repo.getOldest(instanceId, limit);
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
