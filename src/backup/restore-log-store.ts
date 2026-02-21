import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { restoreLog } from "../db/schema/restore-log.js";

export interface RestoreLogEntry {
  id: string;
  tenant: string;
  snapshotKey: string;
  preRestoreKey: string | null;
  restoredAt: number;
  restoredBy: string;
  reason: string | null;
}

export class RestoreLogStore {
  private readonly db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  /** Record a restore event. Returns the created entry. */
  record(params: {
    tenant: string;
    snapshotKey: string;
    preRestoreKey: string | null;
    restoredBy: string;
    reason?: string;
  }): RestoreLogEntry {
    const entry: RestoreLogEntry = {
      id: randomUUID(),
      tenant: params.tenant,
      snapshotKey: params.snapshotKey,
      preRestoreKey: params.preRestoreKey,
      restoredAt: Math.floor(Date.now() / 1000),
      restoredBy: params.restoredBy,
      reason: params.reason ?? null,
    };

    this.db.insert(restoreLog).values(entry).run();

    return entry;
  }

  /** List restore events for a tenant, newest first. */
  listForTenant(tenant: string, limit = 50): RestoreLogEntry[] {
    return this.db
      .select()
      .from(restoreLog)
      .where(eq(restoreLog.tenant, tenant))
      .orderBy(desc(restoreLog.restoredAt))
      .limit(limit)
      .all();
  }

  /** Get a single restore event by ID. */
  get(id: string): RestoreLogEntry | null {
    return this.db.select().from(restoreLog).where(eq(restoreLog.id, id)).get() ?? null;
  }
}
