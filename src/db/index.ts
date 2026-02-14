import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";

export type DrizzleDb = ReturnType<typeof createDb>;

/** Create a Drizzle database instance wrapping the given better-sqlite3 database. */
export function createDb(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

export { schema };
