import { and, asc, count, desc, eq, isNull, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { snapshots } from "../db/schema/snapshots.js";
import type { ISnapshotRepository, NewSnapshotRow } from "./repository-types.js";
import type { Snapshot, SnapshotRow } from "./types.js";
import { rowToSnapshot } from "./types.js";

export class DrizzleSnapshotRepository implements ISnapshotRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(row: NewSnapshotRow): Promise<void> {
    await this.db.insert(snapshots).values(row);
  }

  async getById(id: string): Promise<Snapshot | null> {
    const rows = await this.db.select().from(snapshots).where(eq(snapshots.id, id));
    const row = rows[0];
    return row ? rowToSnapshot(mapDrizzleRow(row)) : null;
  }

  async list(instanceId: string, type?: string): Promise<Snapshot[]> {
    const conditions = type
      ? and(
          eq(snapshots.instanceId, instanceId),
          isNull(snapshots.deletedAt),
          eq(snapshots.type, type as "nightly" | "on-demand" | "pre-restore"),
        )
      : and(eq(snapshots.instanceId, instanceId), isNull(snapshots.deletedAt));

    const rows = await this.db.select().from(snapshots).where(conditions).orderBy(desc(snapshots.createdAt));
    return rows.map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  async listByTenant(tenant: string, type?: string): Promise<Snapshot[]> {
    const conditions = type
      ? and(
          eq(snapshots.tenant, tenant),
          isNull(snapshots.deletedAt),
          eq(snapshots.type, type as "nightly" | "on-demand" | "pre-restore"),
        )
      : and(eq(snapshots.tenant, tenant), isNull(snapshots.deletedAt));

    const rows = await this.db.select().from(snapshots).where(conditions).orderBy(desc(snapshots.createdAt));
    return rows.map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  async countByTenant(tenant: string, type: "on-demand"): Promise<number> {
    const rows = await this.db
      .select({ cnt: count() })
      .from(snapshots)
      .where(and(eq(snapshots.tenant, tenant), eq(snapshots.type, type), isNull(snapshots.deletedAt)));
    return rows[0]?.cnt ?? 0;
  }

  async listAllActive(type: "on-demand"): Promise<Snapshot[]> {
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.type, type), isNull(snapshots.deletedAt)));
    return rows.map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  async listExpired(now: number): Promise<Snapshot[]> {
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(and(isNull(snapshots.deletedAt), lt(snapshots.expiresAt, now)));
    return rows.map((r) => rowToSnapshot(mapDrizzleRow(r)));
  }

  async softDelete(id: string): Promise<void> {
    await this.db.update(snapshots).set({ deletedAt: Date.now() }).where(eq(snapshots.id, id));
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.delete(snapshots).where(eq(snapshots.id, id));
  }

  async count(instanceId: string): Promise<number> {
    const rows = await this.db
      .select({ cnt: count() })
      .from(snapshots)
      .where(and(eq(snapshots.instanceId, instanceId), isNull(snapshots.deletedAt)));
    return rows[0]?.cnt ?? 0;
  }

  async getOldest(instanceId: string, limit: number): Promise<Snapshot[]> {
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.instanceId, instanceId), isNull(snapshots.deletedAt)))
      .orderBy(asc(snapshots.createdAt))
      .limit(limit);
    return rows.map((r) => rowToSnapshot(mapDrizzleRow(r)));
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
