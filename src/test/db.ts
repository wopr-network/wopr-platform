import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DrizzleDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";

// Migrate once per worker process, then snapshot. Each test restores from snapshot
// instead of re-running all migrations — typically 10-20x faster per test.
let migratedSnapshot: Blob | null = null;

async function getSnapshot(): Promise<Blob> {
  if (migratedSnapshot) return migratedSnapshot;
  const pool = new PGlite();
  await migrate(drizzle(pool, { schema }), { migrationsFolder: "./drizzle/migrations" });
  migratedSnapshot = await pool.dumpDataDir("auto");
  await pool.close();
  return migratedSnapshot;
}

export async function createTestDb(): Promise<{ db: DrizzleDb; pool: PGlite }> {
  const snapshot = await getSnapshot();
  const pool = new PGlite({ loadDataDir: snapshot });
  const db = drizzle(pool, { schema }) as unknown as DrizzleDb;
  return { db, pool };
}

export async function truncateAllTables(pool: PGlite): Promise<void> {
  const result = await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const tables = result.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (tables) {
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
}
