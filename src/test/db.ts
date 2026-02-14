import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type DrizzleDb } from "../db/index.js";

export function createTestDb(): { db: DrizzleDb; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  const db = createDb(sqlite);
  migrate(db, { migrationsFolder: "./drizzle/migrations" });
  return { db, sqlite };
}
