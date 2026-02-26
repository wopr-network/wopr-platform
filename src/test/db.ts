import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DrizzleDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";

export async function createTestDb(): Promise<{ db: DrizzleDb; pool: PGlite }> {
  const pool = new PGlite();
  const db = drizzle(pool, { schema }) as unknown as DrizzleDb;
  await migrate(drizzle(pool, { schema }), { migrationsFolder: "./drizzle/migrations" });
  return { db, pool };
}

export async function truncateAllTables(pool: PGlite): Promise<void> {
  const result = await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const tables = result.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (tables) {
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
}
