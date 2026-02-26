import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { DrizzleOnboardingScriptRepository } from "../../onboarding/drizzle-onboarding-script-repository.js";
import { createTestDb } from "../../test/db.js";
import { createAdminOnboardingRoutes } from "./admin-onboarding.js";

describe("admin-onboarding routes", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let app: ReturnType<typeof createAdminOnboardingRoutes>;

  beforeAll(async () => {
    const result = await createTestDb();
    db = result.db;
    pool = result.pool;
    const repo = new DrizzleOnboardingScriptRepository(db);
    app = createAdminOnboardingRoutes(() => repo);
  });

  afterAll(async () => {
    await pool.close();
  });

  it("GET /current returns seed script", async () => {
    const res = await app.request("/current");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.content).toContain("WOPR");
  });

  it("POST / creates a new version", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# New script" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.version).toBeGreaterThan(1);
  });

  it("GET /history returns versions desc", async () => {
    // Ensure at least two versions exist before checking ordering
    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# History test script A" }),
    });
    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# History test script B" }),
    });

    const res = await app.request("/history?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body[0].version).toBeGreaterThan(body[1].version);
  });

  it("POST / rejects empty content", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });
});
