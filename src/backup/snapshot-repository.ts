import { and, asc, count, desc, eq, isNull, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { snapshots } from "../db/schema/snapshots.js";
import type { ISnapshotRepository, NewSnapshotRow } from "./repository-types.js";
import type { Snapshot, SnapshotRow } from "./types.js";
import { rowToSnapshot } from "./types.js";

export class DrizzleSnapshotRepository implements ISnapshotRepository {
  constructor(private readonly db: DrizzleDb) {}

  insert(row: NewSnapshotRow): void {
    this.db.insert(snapshots).values(row).run();
  }

  getById(id: string): Snapshot | null {
    const row = this.db.select().from(snapshots).where(eq(snapshots.id, id)).get();
    return row ? rowToSnapshot(mapDrizzleRow(row)) : null;
  }

  list(instanceId: string, type?: string): Snapshot[] {
    const conditions = type
      ? and(
          eq(snapshots.instanceId, instanceId),
          isNull(snapshots.deletedAt),
          eq(snapshots.type, type as "nightly" | "on-demand" | "pre-restore"),
        )
      : and(eq(snapshots.instanceId, instanceId), isNull(snapshots.deletedAt));

    return this.db
      .select()
      .from(snapshots)
      .where(conditions)
      .orderBy(desc(snapshots.createdAt))
      .all()
      .map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  listByTenant(tenant: string, type?: string): Snapshot[] {
    const conditions = type
      ? and(
          eq(snapshots.tenant, tenant),
          isNull(snapshots.deletedAt),
          eq(snapshots.type, type as "nightly" | "on-demand" | "pre-restore"),
        )
      : and(eq(snapshots.tenant, tenant), isNull(snapshots.deletedAt));

    return this.db
      .select()
      .from(snapshots)
      .where(conditions)
      .orderBy(desc(snapshots.createdAt))
      .all()
      .map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  countByTenant(tenant: string, type: "on-demand"): number {
    const row = this.db
      .select({ cnt: count() })
      .from(snapshots)
      .where(and(eq(snapshots.tenant, tenant), eq(snapshots.type, type), isNull(snapshots.deletedAt)))
      .get();
    return row?.cnt ?? 0;
  }

  listAllActive(type: "on-demand"): Snapshot[] {
    return this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.type, type), isNull(snapshots.deletedAt)))
      .all()
      .map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  listExpired(now: number): Snapshot[] {
    return this.db
      .select()
      .from(snapshots)
      .where(and(isNull(snapshots.deletedAt), lt(snapshots.expiresAt, now)))
      .all()
      .map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  softDelete(id: string): void {
    this.db.update(snapshots).set({ deletedAt: Date.now() }).where(eq(snapshots.id, id)).run();
  }

  hardDelete(id: string): void {
    this.db.delete(snapshots).where(eq(snapshots.id, id)).run();
  }

  count(instanceId: string): number {
    const row = this.db
      .select({ cnt: count() })
      .from(snapshots)
      .where(and(eq(snapshots.instanceId, instanceId), isNull(snapshots.deletedAt)))
      .get();
    return row?.cnt ?? 0;
  }

  getOldest(instanceId: string, limit: number): Snapshot[] {
    return this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.instanceId, instanceId), isNull(snapshots.deletedAt)))
      .orderBy(asc(snapshots.createdAt))
      .limit(limit)
      .all()
      .map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }
}

/** Map Drizzle camelCase row to the SnapshotRow interface (snake_case). */
function mapDrizzleRow(row: typeof snapshots.$inferSelect): SnapshotRow {
  return {
    id: row.id,
    tenant: row.tenant,
    instance_id: row.instanceId,
    user_id: row.userId,
    name: row.name ?? null,
    type: row.type,
    s3_key: row.s3Key ?? null,
    size_mb: row.sizeMb,
    size_bytes: row.sizeBytes ?? null,
    node_id: row.nodeId ?? null,
    trigger: row.trigger,
    plugins: row.plugins,
    config_hash: row.configHash,
    storage_path: row.storagePath,
    created_at: row.createdAt,
    expires_at: row.expiresAt ?? null,
    deleted_at: row.deletedAt ?? null,
  };
}
