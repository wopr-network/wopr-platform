import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { DrizzleMarketplacePluginRepository } from "../../src/marketplace/drizzle-marketplace-plugin-repository.js";
import { createTestDb } from "../../src/test/db.js";

describe("DrizzleMarketplacePluginRepository", () => {
  let repo: DrizzleMarketplacePluginRepository;
  let db: DrizzleDb;
  let pool: PGlite;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleMarketplacePluginRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("insert creates a new plugin with defaults", async () => {
    const plugin = await repo.insert({
      pluginId: "@wopr-network/wopr-plugin-discord",
      npmPackage: "@wopr-network/wopr-plugin-discord",
      version: "1.0.0",
    });
    expect(plugin.pluginId).toBe("@wopr-network/wopr-plugin-discord");
    expect(plugin.enabled).toBeFalsy();
    expect(plugin.featured).toBeFalsy();
    expect(plugin.sortOrder).toBe(999);
  });

  it("findAll returns all plugins", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await repo.insert({ pluginId: "b", npmPackage: "b", version: "2.0.0" });
    expect(await repo.findAll()).toHaveLength(2);
  });

  it("findEnabled returns only enabled plugins sorted by sortOrder", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await repo.insert({ pluginId: "b", npmPackage: "b", version: "1.0.0" });
    await repo.update("b", { enabled: true, sortOrder: 1 });
    const enabled = await repo.findEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].pluginId).toBe("b");
  });

  it("findPendingReview returns disabled plugins", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await repo.insert({ pluginId: "b", npmPackage: "b", version: "1.0.0" });
    await repo.update("a", { enabled: true });
    const pending = await repo.findPendingReview();
    expect(pending).toHaveLength(1);
    expect(pending[0].pluginId).toBe("b");
  });

  it("findById returns undefined for missing plugin", async () => {
    expect(await repo.findById("nonexistent")).toBeUndefined();
  });

  it("update patches fields", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const updated = await repo.update("a", { enabled: true, enabledBy: "admin-1", notes: "Approved" });
    expect(updated.enabled).toBe(true);
    expect(updated.enabledBy).toBe("admin-1");
    expect(updated.notes).toBe("Approved");
    expect(updated.enabledAt).toBeGreaterThan(0);
  });

  it("delete removes a plugin", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await repo.delete("a");
    expect(await repo.findById("a")).toBeUndefined();
  });
});
