import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { DrizzleDb } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Apply all pending Drizzle migrations.
 *
 * In production the compiled JS lives in dist/db/migrate.js, so we resolve
 * the migrations folder relative to the project root (two levels up from
 * dist/db/).  In dev/test the CWD is the project root and the path from
 * src/test/db.ts ("./drizzle/migrations") works fine — but using an
 * absolute path makes both cases work.
 */
export function runMigrations(db: DrizzleDb): void {
  // __dirname = <root>/dist/db  OR  <root>/src/db
  // migrations = <root>/drizzle/migrations
  const migrationsFolder = path.resolve(__dirname, "../../drizzle/migrations");
  migrate(db, { migrationsFolder });
}
