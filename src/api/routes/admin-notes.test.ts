import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../fleet/services.js", () => ({
  getAdminAuditLog: vi.fn().mockReturnValue({ log: vi.fn() }),
  getDb: vi.fn(),
}));

import { createTestDb, truncateAllTables } from "../../test/db.js";
import { createAdminNotesApiRoutes } from "./admin-notes.js";

describe("admin-notes routes", () => {
  let pool: PGlite;
  let app: ReturnType<typeof createAdminNotesApiRoutes>;

  beforeAll(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    app = createAdminNotesApiRoutes(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  // GET /:tenantId

  describe("GET /:tenantId", () => {
    it("returns empty list for tenant with no notes", async () => {
      const res = await app.request("/tenant-a");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns notes for a tenant after creation", async () => {
      await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "First note" }),
      });

      const res = await app.request("/tenant-a");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].content).toBe("First note");
    });

    it("does not return notes from other tenants", async () => {
      await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Tenant A note" }),
      });

      const res = await app.request("/tenant-b");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
    });

    it("accepts limit and offset params", async () => {
      const res = await app.request("/tenant-a?limit=10&offset=0");
      expect(res.status).toBe(200);
    });
  });

  // POST /:tenantId

  describe("POST /:tenantId", () => {
    it("creates a note and returns 201", async () => {
      const res = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Important note" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty("id");
      expect(body.content).toBe("Important note");
      expect(body.tenantId).toBe("tenant-a");
    });

    it("creates a pinned note when isPinned is true", async () => {
      const res = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Pinned note", isPinned: true }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isPinned).toBe(true);
    });

    it("rejects empty content with 400", async () => {
      const res = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/content/);
    });

    it("rejects whitespace-only content with 400", async () => {
      const res = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "   " }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing content with 400", async () => {
      const res = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body with 400", async () => {
      const res = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "bad-json{",
      });
      expect(res.status).toBe(400);
    });
  });

  // PATCH /:tenantId/:noteId

  describe("PATCH /:tenantId/:noteId", () => {
    it("updates note content", async () => {
      const createRes = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Original" }),
      });
      const created = await createRes.json();

      const res = await app.request(`/tenant-a/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Updated" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toBe("Updated");
    });

    it("updates isPinned flag", async () => {
      const createRes = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Note" }),
      });
      const created = await createRes.json();

      const res = await app.request(`/tenant-a/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPinned: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isPinned).toBe(true);
    });

    it("returns 403 for nonexistent note", async () => {
      const res = await app.request("/tenant-a/nonexistent-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "updated" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 when noteId belongs to different tenant", async () => {
      const createRes = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Note for tenant-a" }),
      });
      const created = await createRes.json();

      const res = await app.request(`/tenant-b/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Tampered" }),
      });
      expect(res.status).toBe(403);
    });
  });

  // DELETE /:tenantId/:noteId

  describe("DELETE /:tenantId/:noteId", () => {
    it("deletes note and returns ok", async () => {
      const createRes = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "To delete" }),
      });
      const created = await createRes.json();

      const res = await app.request(`/tenant-a/${created.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 403 for nonexistent note", async () => {
      const res = await app.request("/tenant-a/nonexistent-id", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 when attempting cross-tenant delete", async () => {
      const createRes = await app.request("/tenant-a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Tenant A note" }),
      });
      const created = await createRes.json();

      const res = await app.request(`/tenant-b/${created.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });
  });
});
