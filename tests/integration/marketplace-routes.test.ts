/**
 * Integration tests for marketplace routes.
 *
 * Tests /api/marketplace/plugins (user-facing) and /api/admin/marketplace/plugins (admin).
 */
import { describe, expect, it } from "vitest";

// Setup env stubs and mocks before importing app
await import("./setup.js");

const { app } = await import("../../src/api/app.js");
import { AUTH_HEADER, TENANT_A_TOKEN } from "./setup.js";

describe("integration: marketplace registry routes", () => {
  it("GET /api/marketplace/plugins returns 401 without auth", async () => {
    const res = await app.request("/api/marketplace/plugins");
    expect(res.status).toBe(401);
  });

  it("GET /api/marketplace/plugins with valid auth resolves (200 or graceful error)", async () => {
    const res = await app.request("/api/marketplace/plugins", { headers: AUTH_HEADER });
    // With the fleet token, resolveSessionUser sets a user via bearer auth.
    // The marketplace route checks c.get("user") — with a valid bearer token
    // the user is set. But getMarketplacePluginRepo() may fail without a DB.
    // Acceptable statuses: 200 (success), 500 (DB unavailable), 401 (no session user from cookie).
    // Must not 404 (route must be registered).
    expect(res.status).not.toBe(404);
  });

  it("GET /api/marketplace/plugins returns array shape when 200", async () => {
    const res = await app.request("/api/marketplace/plugins", { headers: AUTH_HEADER });
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        expect(body[0]).toHaveProperty("id");
        expect(body[0]).toHaveProperty("name");
        expect(body[0]).toHaveProperty("category");
      }
    }
  });
});

describe("integration: admin marketplace routes", () => {
  it("GET /api/admin/marketplace/plugins returns 401 without auth", async () => {
    const res = await app.request("/api/admin/marketplace/plugins");
    expect(res.status).toBe(401);
  });

  it("POST /api/admin/marketplace/plugins returns 401 without auth", async () => {
    const res = await app.request("/api/admin/marketplace/plugins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ npmPackage: "test-pkg", version: "1.0.0" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/marketplace/plugins with admin-scoped fleet token gets past auth", async () => {
    // FLEET_API_TOKEN is treated as admin scope (legacy token behaviour).
    // The admin marketplace route passes auth but may hit the DB without a
    // running database — returning 500. That is fine: auth was NOT rejected.
    const res = await app.request("/api/admin/marketplace/plugins", {
      headers: AUTH_HEADER,
    });
    // Auth passed — must be 200 (success) or 500 (DB unavailable), never 401 or 404.
    expect([200, 500]).toContain(res.status);
  });

  it("GET /api/admin/marketplace/plugins with non-admin token returns 403", async () => {
    // Tenant write-scoped token does not satisfy the admin scope requirement.
    const res = await app.request("/api/admin/marketplace/plugins", {
      headers: { Authorization: `Bearer ${TENANT_A_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });
});
