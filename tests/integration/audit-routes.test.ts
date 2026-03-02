/**
 * Integration tests for /api/audit and /api/admin/audit routes.
 *
 * Verifies that auth guards are applied correctly.
 * Avoids DB by relying on auth checks that fire before any DB access.
 */
import { describe, expect, it } from "vitest";

// Setup env stubs and mocks before importing app
await import("./setup.js");

const { app } = await import("../../src/api/app.js");
import { AUTH_HEADER } from "./setup.js";

describe("integration: audit routes", () => {
  it("GET /api/audit returns 401 without auth", async () => {
    const res = await app.request("/api/audit");
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/audit returns 401 without auth", async () => {
    const res = await app.request("/api/admin/audit");
    expect(res.status).toBe(401);
  });

  it("GET /api/audit returns 401 with wrong token", async () => {
    const res = await app.request("/api/audit", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/audit with admin-scoped fleet token gets past auth", async () => {
    // FLEET_API_TOKEN is treated as admin scope (legacy token behaviour).
    // The admin audit route passes auth, then hits the audit repo.
    // Without a real DB the route returns 500 (DB unavailable) — that still
    // proves the auth guard is NOT rejecting the request.
    const res = await app.request("/api/admin/audit", {
      headers: AUTH_HEADER,
    });
    // Auth passed — must be 200 (success) or 500 (DB unavailable), never 401 or 404.
    expect([200, 500]).toContain(res.status);
  });
});
