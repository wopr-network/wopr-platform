import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/index.js";
import { DrizzleMarketplaceContentRepository } from "./marketplace-content-repository.js";

describe("DrizzleMarketplaceContentRepository", () => {
  let repo: DrizzleMarketplaceContentRepository;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    const db = createDb(sqlite);
    migrate(db, { migrationsFolder: "drizzle/migrations" });
    repo = new DrizzleMarketplaceContentRepository(db);
  });

  it("upserts and retrieves content", () => {
    repo.upsert({
      pluginId: "test-plugin",
      version: "1.0.0",
      markdown: "# Test",
      source: "superpower_md",
      updatedAt: Date.now(),
    });

    const row = repo.getByPluginId("test-plugin");
    expect(row).not.toBeNull();
    expect(row!.markdown).toBe("# Test");
    expect(row!.source).toBe("superpower_md");
  });

  it("returns null for missing plugin", () => {
    const row = repo.getByPluginId("nonexistent");
    expect(row).toBeNull();
  });

  it("updates on version change", () => {
    repo.upsert({
      pluginId: "test-plugin",
      version: "1.0.0",
      markdown: "# Old",
      source: "superpower_md",
      updatedAt: 1000,
    });
    repo.upsert({
      pluginId: "test-plugin",
      version: "2.0.0",
      markdown: "# New",
      source: "superpower_md",
      updatedAt: 2000,
    });

    const row = repo.getByPluginId("test-plugin");
    expect(row!.version).toBe("2.0.0");
    expect(row!.markdown).toBe("# New");
  });
});
