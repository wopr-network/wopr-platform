/**
 * Integration tests for /health routes.
 *
 * Tests the health endpoint through the full Hono app with real routing.
 */
import { describe, expect, it } from "vitest";
import { AUTH_HEADER } from "./setup.js";

const { app } = await import("../../src/api/app.js");

describe("integration: health routes", () => {
  it("GET /health returns status ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("wopr-platform");
  });

  it("GET /health does not require authentication", async () => {
    // No Authorization header -- should still succeed
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.request("/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown API routes without auth", async () => {
    // Unknown /api/* paths return 404 — auth middleware only runs on
    // routes that have handlers, not on unmatched paths.
    const res = await app.request("/api/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown API routes with valid auth", async () => {
    const res = await app.request("/api/nonexistent", { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });
});
