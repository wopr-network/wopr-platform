import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@wopr-network/platform-core/db/schema/index";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  const db = drizzle(pool, { schema });
  const migrationsFolder = path.resolve(__dirname, "../../drizzle/migrations");
  await migrate(db, { migrationsFolder });
}
