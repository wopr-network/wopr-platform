import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { restoreLog } from "../db/schema/restore-log.js";
import type { IRestoreLogRepository, NewRestoreLogEntry, RestoreLogEntry } from "./repository-types.js";

export class DrizzleRestoreLogRepository implements IRestoreLogRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(entry: NewRestoreLogEntry): Promise<void> {
    await this.db.insert(restoreLog).values(entry);
  }

  async getById(id: string): Promise<RestoreLogEntry | null> {
    const rows = await this.db.select().from(restoreLog).where(eq(restoreLog.id, id));
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async listByTenant(tenant: string, limit: number): Promise<RestoreLogEntry[]> {
    const rows = await this.db
      .select()
      .from(restoreLog)
      .where(eq(restoreLog.tenant, tenant))
      .orderBy(desc(restoreLog.restoredAt))
      .limit(limit);
    return rows.map(toEntry);
  }
}

function toEntry(row: typeof restoreLog.$inferSelect): RestoreLogEntry {
  return {
    id: row.id,
    tenant: row.tenant,
    snapshotKey: row.snapshotKey,
    preRestoreKey: row.preRestoreKey ?? null,
    restoredAt: row.restoredAt,
    restoredBy: row.restoredBy,
    reason: row.reason ?? null,
  };
}
