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
