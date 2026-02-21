import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { BackupStatusStore } from "../../backup/backup-status-store.js";
import { applyPlatformPragmas } from "../../db/pragmas.js";
import * as dbSchema from "../../db/schema/index.js";

const BACKUP_DB_PATH = process.env.BACKUP_DB_PATH || "/data/platform/backup-status.db";

/** Lazy-initialized backup status store for health checks */
let _healthStore: BackupStatusStore | null = null;
function getHealthStore(): BackupStatusStore | null {
  if (_healthStore) return _healthStore;
  try {
    const sqlite = new Database(BACKUP_DB_PATH);
    applyPlatformPragmas(sqlite);
    // Don't CREATE TABLE here — only read. If the DB doesn't exist yet, return null.
    const db = drizzle(sqlite, { schema: dbSchema });
    _healthStore = new BackupStatusStore(db);
    return _healthStore;
  } catch {
    // Backup DB not initialized yet — that's fine for fresh deployments
    return null;
  }
}

// BOUNDARY(WOP-805): REST is the correct layer for health checks.
// Public, unauthenticated, used by load balancers and monitoring.
// Note: tRPC settings.health also exists as a tRPC-level health check
// for the tRPC adapter itself — both are intentional.
export function createHealthRoutes(storeFactory?: () => BackupStatusStore | null): Hono {
  const routes = new Hono();
  const resolveStore = storeFactory ?? getHealthStore;

  routes.get("/", (c) => {
    const health: {
      status: string;
      service: string;
      backups?: { staleCount: number; totalTracked: number };
    } = {
      status: "ok",
      service: "wopr-platform",
    };

    const store = resolveStore();
    if (store) {
      try {
        const stale = store.listStale();
        const total = store.count();
        health.backups = { staleCount: stale.length, totalTracked: total };
        if (stale.length > 0) {
          health.status = "degraded";
        }
      } catch {
        // Backup DB query failed — don't crash the health endpoint
      }
    }

    return c.json(health);
  });

  return routes;
}

/** Pre-built health routes with lazy backup store initialization. */
export const healthRoutes = createHealthRoutes();
