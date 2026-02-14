import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema/index.js";

const sqlite = new Database(process.env.DATABASE_PATH || "./data/platform.db");
export const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: "./drizzle/migrations" });
