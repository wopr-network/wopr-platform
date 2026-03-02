import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleMarketplacePluginRepository } from "./drizzle-marketplace-plugin-repository.js";

describe("DrizzleMarketplacePluginRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleMarketplacePluginRepository;

  beforeAll(async () => {
    const result = await createTestDb();
    db = result.db;
    pool = result.pool;
    repo = new DrizzleMarketplacePluginRepository(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  it("insert creates a new marketplace plugin", async () => {
    const plugin = await repo.insert({
      pluginId: "plugin-1",
      npmPackage: "@wopr-network/plugin-test",
      version: "1.0.0",
      category: "utility",
      notes: "Test plugin",
    });
    expect(plugin.pluginId).toBe("plugin-1");
    expect(plugin.npmPackage).toBe("@wopr-network/plugin-test");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.enabled).toBe(false);
    expect(plugin.featured).toBe(false);
    expect(plugin.category).toBe("utility");
    expect(plugin.notes).toBe("Test plugin");
    expect(plugin.discoveredAt).toBeGreaterThan(0);
    expect(plugin.enabledAt).toBeNull();
    expect(plugin.installedAt).toBeNull();
    expect(plugin.installError).toBeNull();
  });

  it("findById returns the inserted plugin", async () => {
    const found = await repo.findById("plugin-1");
    expect(found).not.toBeNull();
    expect(found?.pluginId).toBe("plugin-1");
  });

  it("findById returns undefined for missing plugin", async () => {
    const found = await repo.findById("nonexistent");
    expect(found).toBeUndefined();
  });

  it("findAll returns all plugins ordered by sortOrder", async () => {
    await repo.insert({ pluginId: "plugin-2", npmPackage: "@wopr-network/plugin-b", version: "2.0.0" });
    const all = await repo.findAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("findEnabled returns only enabled plugins", async () => {
    await repo.update("plugin-1", { enabled: true, enabledBy: "admin" });
    const enabled = await repo.findEnabled();
    expect(enabled.length).toBeGreaterThanOrEqual(1);
    expect(enabled.every((p) => p.enabled)).toBe(true);
  });

  it("update sets enabledAt automatically when enabling", async () => {
    const updated = await repo.findById("plugin-1");
    expect(updated?.enabled).toBe(true);
    expect(updated?.enabledAt).not.toBeNull();
    expect(updated?.enabledBy).toBe("admin");
  });

  it("findPendingReview returns disabled plugins", async () => {
    const pending = await repo.findPendingReview();
    expect(pending.every((p) => !p.enabled)).toBe(true);
    const ids = pending.map((p) => p.pluginId);
    expect(ids).toContain("plugin-2");
  });

  it("update can change version and notes", async () => {
    const updated = await repo.update("plugin-1", { version: "1.1.0", notes: "Updated" });
    expect(updated.version).toBe("1.1.0");
    expect(updated.notes).toBe("Updated");
  });

  it("setInstallResult records install success", async () => {
    const now = Date.now();
    await repo.setInstallResult("plugin-1", now, null);
    const found = await repo.findById("plugin-1");
    expect(found?.installedAt).toBe(now);
    expect(found?.installError).toBeNull();
  });

  it("setInstallResult records install failure", async () => {
    await repo.setInstallResult("plugin-2", null, "ENOENT: package not found");
    const found = await repo.findById("plugin-2");
    expect(found?.installedAt).toBeNull();
    expect(found?.installError).toBe("ENOENT: package not found");
  });

  it("delete removes the plugin", async () => {
    await repo.delete("plugin-2");
    const found = await repo.findById("plugin-2");
    expect(found).toBeUndefined();
  });

  it("update throws for nonexistent plugin", async () => {
    await expect(repo.update("nonexistent", { enabled: true })).rejects.toThrow();
  });
});
