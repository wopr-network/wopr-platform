import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createDb } from "./index.js";
import { runMigrations } from "./migrate.js";

describe("runMigrations", () => {
  it("should apply all migrations to a fresh database", () => {
    const sqlite = new Database(":memory:");
    const db = createDb(sqlite);
    runMigrations(db);
    // After migrations, the bot_instances table should exist
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("bot_instances");
    expect(tableNames).toContain("nodes");
    sqlite.close();
  });

  it("should be idempotent — running twice does not throw", () => {
    const sqlite = new Database(":memory:");
    const db = createDb(sqlite);
    runMigrations(db);
    runMigrations(db); // second call should be a no-op
    sqlite.close();
  });
});
