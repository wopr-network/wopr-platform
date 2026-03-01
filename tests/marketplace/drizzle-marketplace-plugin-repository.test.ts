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

  it("setInstallResult records successful install", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const now = Date.now();
    await repo.setInstallResult("a", now, null);
    const plugin = await repo.findById("a");
    expect(plugin!.installedAt).toBe(now);
    expect(plugin!.installError).toBeNull();
  });

  it("setInstallResult records install failure", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await repo.setInstallResult("a", null, "npm install failed: ENOMEM");
    const plugin = await repo.findById("a");
    expect(plugin!.installedAt).toBeNull();
    expect(plugin!.installError).toBe("npm install failed: ENOMEM");
  });

  it("setInstallResult clears previous install error on success", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await repo.setInstallResult("a", null, "first failure");
    const now = Date.now();
    await repo.setInstallResult("a", now, null);
    const plugin = await repo.findById("a");
    expect(plugin!.installedAt).toBe(now);
    expect(plugin!.installError).toBeNull();
  });

  it("insert with duplicate pluginId throws", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await expect(
      repo.insert({ pluginId: "a", npmPackage: "a", version: "2.0.0" }),
    ).rejects.toThrow();
  });

  it("update on nonexistent pluginId throws", async () => {
    await expect(
      repo.update("nonexistent", { enabled: true }),
    ).rejects.toThrow("Marketplace plugin not found after update: nonexistent");
  });

  it("delete on nonexistent pluginId is a no-op", async () => {
    await expect(repo.delete("nonexistent")).resolves.not.toThrow();
  });

  it("findAll returns plugins ordered by sortOrder ascending", async () => {
    await repo.insert({ pluginId: "z", npmPackage: "z", version: "1.0.0" });
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    await repo.update("z", { sortOrder: 1 });
    await repo.update("a", { sortOrder: 2 });
    const all = await repo.findAll();
    expect(all[0].pluginId).toBe("z");
    expect(all[1].pluginId).toBe("a");
  });

  it("findPendingReview returns plugins ordered by discoveredAt ascending", async () => {
    await repo.insert({ pluginId: "first", npmPackage: "first", version: "1.0.0" });
    await new Promise((r) => setTimeout(r, 5));
    await repo.insert({ pluginId: "second", npmPackage: "second", version: "1.0.0" });
    const pending = await repo.findPendingReview();
    expect(pending).toHaveLength(2);
    expect(pending[0].pluginId).toBe("first");
    expect(pending[1].pluginId).toBe("second");
  });

  it("insert sets discoveredAt automatically", async () => {
    const before = Date.now();
    const plugin = await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const after = Date.now();
    expect(plugin.discoveredAt).toBeGreaterThanOrEqual(before);
    expect(plugin.discoveredAt).toBeLessThanOrEqual(after);
  });

  it("insert with optional category and notes", async () => {
    const plugin = await repo.insert({
      pluginId: "a",
      npmPackage: "a",
      version: "1.0.0",
      category: "voice",
      notes: "Voice plugin",
    });
    expect(plugin.category).toBe("voice");
    expect(plugin.notes).toBe("Voice plugin");
  });

  it("update with empty patch is a no-op", async () => {
    const original = await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const updated = await repo.update("a", {});
    expect(updated.pluginId).toBe(original.pluginId);
    expect(updated.version).toBe(original.version);
  });

  it("update version field", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const updated = await repo.update("a", { version: "2.0.0" });
    expect(updated.version).toBe("2.0.0");
  });

  it("update featured field", async () => {
    await repo.insert({ pluginId: "a", npmPackage: "a", version: "1.0.0" });
    const updated = await repo.update("a", { featured: true });
    expect(updated.featured).toBe(true);
  });
});
