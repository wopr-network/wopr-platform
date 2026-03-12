import { describe, expect, it, vi } from "vitest";

/**
 * WOP-1349 — Verify tenant-scoped tokens cannot access GPU provisioning.
 *
 * Unlike admin-gpu.test.ts (which mocks auth to auto-pass), this test
 * exercises the REAL scopedBearerAuthWithTenant middleware to confirm
 * that a write-scoped tenant token is rejected.
 */

// Set up a tenant-scoped token (write scope, NOT admin)
const TENANT_ID = "tenant-test-denial";
const TENANT_TOKEN = "wopr_write_denialtest00000001";
vi.stubEnv(`FLEET_TOKEN_${TENANT_ID}`, `write:${TENANT_TOKEN}`);
vi.stubEnv("PLATFORM_SECRET", "test-platform-secret-32bytes!!ok");

// Mock fleet services so we don't need a real DB — the request should
// never reach the handler, but mock anyway to be safe.
vi.mock("@wopr-network/platform-core/fleet/services", () => ({
  getGpuNodeRepository: vi.fn().mockReturnValue({ list: () => [] }),
  getGpuNodeProvisioner: vi.fn().mockReturnValue({
    provision: vi.fn().mockRejectedValue(new Error("should not be called")),
  }),
  getDOClient: vi.fn().mockReturnValue({
    listRegions: vi.fn().mockResolvedValue([]),
    listSizes: vi.fn().mockResolvedValue([]),
  }),
  getAdminAuditLog: vi.fn().mockReturnValue({ log: vi.fn() }),
}));

// Do NOT mock auth — use the real scopedBearerAuthWithTenant
import { adminGpuRoutes } from "./admin-gpu.js";

describe("admin-gpu tenant denial (WOP-1349)", () => {
  const tenantAuth = { Authorization: `Bearer ${TENANT_TOKEN}` };

  it("should reject tenant token on POST / (provision)", async () => {
    const res = await adminGpuRoutes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenantAuth },
      body: JSON.stringify({ region: "nyc1" }),
    });

    // Tenant write token lacks admin scope — expect 401 or 403
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("should reject tenant token on GET / (list nodes)", async () => {
    const res = await adminGpuRoutes.request("/", {
      headers: tenantAuth,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("should reject tenant token on DELETE /:nodeId", async () => {
    const res = await adminGpuRoutes.request("/some-node-id", {
      method: "DELETE",
      headers: tenantAuth,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("should reject unauthenticated requests", async () => {
    const res = await adminGpuRoutes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "nyc1" }),
    });

    expect(res.status).toBe(401);
  });
});
