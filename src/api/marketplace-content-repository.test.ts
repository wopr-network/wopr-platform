import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleMarketplaceContentRepository } from "./marketplace-content-repository.js";

describe("DrizzleMarketplaceContentRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleMarketplaceContentRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleMarketplaceContentRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("upserts and retrieves content", async () => {
    await repo.upsert({
      pluginId: "test-plugin",
      version: "1.0.0",
      markdown: "# Test",
      source: "superpower_md",
      updatedAt: Date.now(),
    });

    const row = await repo.getByPluginId("test-plugin");
    expect(row).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: row is asserted not-null above
    expect(row!.markdown).toBe("# Test");
    // biome-ignore lint/style/noNonNullAssertion: row is asserted not-null above
    expect(row!.source).toBe("superpower_md");
  });

  it("returns null for missing plugin", async () => {
    const row = await repo.getByPluginId("nonexistent");
    expect(row).toBeNull();
  });

  it("updates on version change", async () => {
    await repo.upsert({
      pluginId: "test-plugin",
      version: "1.0.0",
      markdown: "# Old",
      source: "superpower_md",
      updatedAt: 1000,
    });
    await repo.upsert({
      pluginId: "test-plugin",
      version: "2.0.0",
      markdown: "# New",
      source: "superpower_md",
      updatedAt: 2000,
    });

    const row = await repo.getByPluginId("test-plugin");
    // biome-ignore lint/style/noNonNullAssertion: row is known to exist after upsert
    expect(row!.version).toBe("2.0.0");
    // biome-ignore lint/style/noNonNullAssertion: row is known to exist after upsert
    expect(row!.markdown).toBe("# New");
  });
});
