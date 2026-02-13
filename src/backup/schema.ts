import type Database from "better-sqlite3";

/** Create the snapshots table and indexes if they don't exist */
export function initSnapshotSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      size_mb REAL NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'pre_update')),
      plugins TEXT NOT NULL DEFAULT '[]',
      config_hash TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_instance
      ON snapshots (instance_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_snapshots_user
      ON snapshots (user_id);
  `);
}
