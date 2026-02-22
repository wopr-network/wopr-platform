import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { restoreLog } from "../db/schema/restore-log.js";
import type { IRestoreLogRepository, NewRestoreLogEntry, RestoreLogEntry } from "./repository-types.js";

export class DrizzleRestoreLogRepository implements IRestoreLogRepository {
  constructor(private readonly db: DrizzleDb) {}

  insert(entry: NewRestoreLogEntry): void {
    this.db.insert(restoreLog).values(entry).run();
  }

  getById(id: string): RestoreLogEntry | null {
    const row = this.db.select().from(restoreLog).where(eq(restoreLog.id, id)).get();
    return row ? toEntry(row) : null;
  }

  listByTenant(tenant: string, limit: number): RestoreLogEntry[] {
    return this.db
      .select()
      .from(restoreLog)
      .where(eq(restoreLog.tenant, tenant))
      .orderBy(desc(restoreLog.restoredAt))
      .limit(limit)
      .all()
      .map(toEntry);
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
