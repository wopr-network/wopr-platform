import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema/index.js";
import { DrizzleMarketplacePluginRepository } from "../../src/marketplace/drizzle-marketplace-plugin-repository.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE marketplace_plugins (
      plugin_id TEXT PRIMARY KEY,
      npm_package TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      featured INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 999,
      category TEXT,
      discovered_at INTEGER NOT NULL,
      enabled_at INTEGER,
      enabled_by TEXT,
      notes TEXT
    )
  `);
  return db;
}

describe("DrizzleMarketplacePluginRepository", () => {
  let repo: DrizzleMarketplacePluginRepository;

  beforeEach(() => {
    const db = createTestDb();
    repo = new DrizzleMarketplacePluginRepository(db);
  });

  it("insert creates a new plugin with defaults", () => {
    const plugin = repo.insert({
      pluginId: "@wopr-network/wopr-plugin-discord",
      npmPackage: "@wopr-network/wopr-plugin-discord",
      version: "1.0.0",
    });
    expect(plugin.pluginId).toBe("@wopr-network/wopr-plugin-discord");
    expect(plugin.enabled).toBe(false);
    expect(plugin.featured).toBe(false);
    expect(plugin.sortOrder).toBe(999);
  });

  it("findAll returns all plugins", () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    repo.insert({ pluginId: "b", npmPackage: "b", version: "2.0.0" });
    expect(repo.findAll()).toHaveLength(2);
  });

  it("findEnabled returns only enabled plugins sorted by sortOrder", () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    repo.insert({ pluginId: "b", npmPackage: "b", version: "1.0.0" });
    repo.update("b", { enabled: true, sortOrder: 1 });
    const enabled = repo.findEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].pluginId).toBe("b");
  });

  it("findPendingReview returns disabled plugins", () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    repo.insert({ pluginId: "b", npmPackage: "b", version: "1.0.0" });
    repo.update("a", { enabled: true });
    const pending = repo.findPendingReview();
    expect(pending).toHaveLength(1);
    expect(pending[0].pluginId).toBe("b");
  });

  it("findById returns undefined for missing plugin", () => {
    expect(repo.findById("nonexistent")).toBeUndefined();
  });

  it("update patches fields", () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const updated = repo.update("a", { enabled: true, enabledBy: "admin-1", notes: "Approved" });
    expect(updated.enabled).toBe(true);
    expect(updated.enabledBy).toBe("admin-1");
    expect(updated.notes).toBe("Approved");
    expect(updated.enabledAt).toBeGreaterThan(0);
  });

  it("delete removes a plugin", () => {
    repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    repo.delete("a");
    expect(repo.findById("a")).toBeUndefined();
  });
});
