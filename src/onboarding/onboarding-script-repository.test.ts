import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleOnboardingScriptRepository } from "./onboarding-script-repository.js";

describe("DrizzleOnboardingScriptRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleOnboardingScriptRepository;

  beforeAll(async () => {
    const result = await createTestDb();
    db = result.db;
    pool = result.pool;
    repo = new DrizzleOnboardingScriptRepository(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  it("findCurrent returns the seed script", async () => {
    const script = await repo.findCurrent();
    expect(script).toBeDefined();
    expect(script?.version).toBe(1);
    expect(script?.content).toContain("WOPR");
  });

  it("insert appends a new version", async () => {
    const inserted = await repo.insert({ content: "# Updated script v2", updatedBy: "admin-1" });
    expect(inserted.version).toBe(2);
    expect(inserted.content).toBe("# Updated script v2");
    expect(inserted.updatedBy).toBe("admin-1");

    const current = await repo.findCurrent();
    expect(current?.id).toBe(inserted.id);
    expect(current?.version).toBe(2);
  });

  it("findHistory returns versions in descending order", async () => {
    const history = await repo.findHistory(10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].version).toBeGreaterThan(history[1].version);
  });

  it("insert auto-increments version from highest existing", async () => {
    const v3 = await repo.insert({ content: "# v3" });
    expect(v3.version).toBe(3);
    const v4 = await repo.insert({ content: "# v4" });
    expect(v4.version).toBe(4);
  });
});
