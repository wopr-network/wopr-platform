import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import * as schema from "./schema/index.js";

/** The schema type shared across all db instances. */
export type Schema = typeof schema;

/**
 * Structural DrizzleDb type — satisfied by both NodePgDatabase (production)
 * and PgliteDatabase (tests). Repositories accept this type.
 */
export type DrizzleDb = PgDatabase<PgQueryResultHKT, Schema>;

/** Create a Drizzle database instance wrapping the given pg.Pool. */
export function createDb(pool: Pool): DrizzleDb {
  return drizzle(pool, { schema }) as unknown as DrizzleDb;
}

export { schema };
export { creditColumn } from "./credit-column.js";
