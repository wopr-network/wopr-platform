import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { createAdminUsersApiRoutes } from "./admin-users.js";

describe("admin-users routes", () => {
  let pool: PGlite;
  let app: ReturnType<typeof createAdminUsersApiRoutes>;

  beforeAll(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    app = createAdminUsersApiRoutes(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  // GET /

  describe("GET /", () => {
    it("returns empty list when no users exist", async () => {
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("accepts search query param", async () => {
      const res = await app.request("/?search=alice");
      expect(res.status).toBe(200);
    });

    it("accepts valid status filter", async () => {
      const res = await app.request("/?status=active");
      expect(res.status).toBe(200);
    });

    it("ignores invalid status filter", async () => {
      const res = await app.request("/?status=invalid_status");
      expect(res.status).toBe(200);
    });

    it("accepts valid role filter", async () => {
      const res = await app.request("/?role=platform_admin");
      expect(res.status).toBe(200);
    });

    it("ignores invalid role filter", async () => {
      const res = await app.request("/?role=superuser");
      expect(res.status).toBe(200);
    });

    it("accepts hasCredits boolean filter", async () => {
      const res = await app.request("/?hasCredits=true");
      expect(res.status).toBe(200);
    });

    it("accepts lowBalance boolean filter", async () => {
      const res = await app.request("/?lowBalance=true");
      expect(res.status).toBe(200);
    });

    it("accepts valid sortBy param", async () => {
      const res = await app.request("/?sortBy=last_seen");
      expect(res.status).toBe(200);
    });

    it("ignores invalid sortBy param", async () => {
      const res = await app.request("/?sortBy=invalid_field");
      expect(res.status).toBe(200);
    });

    it("accepts valid sortOrder param", async () => {
      const res = await app.request("/?sortOrder=asc");
      expect(res.status).toBe(200);
    });

    it("ignores invalid sortOrder param", async () => {
      const res = await app.request("/?sortOrder=sideways");
      expect(res.status).toBe(200);
    });

    it("accepts limit and offset params", async () => {
      const res = await app.request("/?limit=25&offset=50");
      expect(res.status).toBe(200);
    });
  });

  // GET /:userId

  describe("GET /:userId", () => {
    it("returns 404 for unknown user", async () => {
      const res = await app.request("/nonexistent-user-id");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });
  });
});
