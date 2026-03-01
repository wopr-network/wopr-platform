/**
 * Integration tests for /api/instances/:id/snapshots/* routes.
 *
 * Tests snapshot endpoints through the full composed Hono app.
 * SnapshotManager is mocked (no real filesystem).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS, TENANT_A_TOKEN, TENANT_B_TOKEN, snapshotManagerMock } from "./setup.js";

const { app } = await import("../../src/api/app.js");

const mockSnapshot = {
  id: "snap-1",
  instanceId: "inst-1",
  userId: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  sizeMb: 1.5,
  trigger: "manual" as const,
  plugins: ["discord"],
  configHash: "abc123",
  storagePath: "/data/snapshots/inst-1/snap-1.tar.gz",
};

describe("integration: snapshot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Authentication -------------------------------------------------------

  describe("auth middleware", () => {
    it("rejects requests without token", async () => {
      const res = await app.request("/api/instances/inst-1/snapshots");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await app.request("/api/instances/inst-1/snapshots", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -- Path traversal protection --------------------------------------------

  describe("path traversal protection", () => {
    it("rejects instance ID with spaces", async () => {
      const res = await app.request("/api/instances/inst%20bad/snapshots", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(400);
    });
  });

  // -- POST /api/instances/:id/snapshots ------------------------------------

  describe("POST /api/instances/:id/snapshots", () => {
    it("creates a snapshot", async () => {
      snapshotManagerMock.create.mockResolvedValue(mockSnapshot);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ trigger: "manual" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("snap-1");
    });

    it("creates a snapshot with empty body (defaults to manual)", async () => {
      snapshotManagerMock.create.mockResolvedValue(mockSnapshot);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(201);
    });

    it("rejects scheduled trigger on free tier (tier from DB, not header)", async () => {
      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ trigger: "scheduled" }),
      });
      expect(res.status).toBe(403);
    });

    it("X-Tier: pro header does not grant pro tier — DB tier (free) is used", async () => {
      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Tier": "pro" },
        body: JSON.stringify({ trigger: "scheduled" }),
      });
      // Must still be 403 — DB says "free", header is ignored
      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "not json{{{",
      });
      expect(res.status).toBe(400);
    });

    it("returns 500 on manager error", async () => {
      snapshotManagerMock.create.mockRejectedValue(new Error("tar failed"));

      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ trigger: "manual" }),
      });
      expect(res.status).toBe(500);
    });
  });

  // -- GET /api/instances/:id/snapshots -------------------------------------

  describe("GET /api/instances/:id/snapshots", () => {
    it("lists snapshots for an instance", async () => {
      snapshotManagerMock.list.mockReturnValue([mockSnapshot]);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        headers: AUTH_HEADER,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toHaveLength(1);
      expect(body.snapshots[0].id).toBe("snap-1");
    });

    it("returns empty list when no snapshots", async () => {
      snapshotManagerMock.list.mockReturnValue([]);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        headers: AUTH_HEADER,
      });

      const body = await res.json();
      expect(body.snapshots).toEqual([]);
    });
  });

  // -- POST /api/instances/:id/snapshots/:sid/restore -----------------------

  describe("POST .../snapshots/:sid/restore", () => {
    it("restores from snapshot", async () => {
      snapshotManagerMock.get.mockReturnValue(mockSnapshot);
      snapshotManagerMock.restore.mockResolvedValue(undefined);

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1/restore", {
        method: "POST",
        headers: AUTH_HEADER,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.restored).toBe("snap-1");
    });

    it("returns 404 for missing snapshot", async () => {
      snapshotManagerMock.get.mockReturnValue(null);

      const res = await app.request("/api/instances/inst-1/snapshots/missing/restore", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when snapshot belongs to different instance", async () => {
      snapshotManagerMock.get.mockReturnValue({ ...mockSnapshot, instanceId: "inst-other" });

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1/restore", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(403);
    });
  });

  // -- DELETE /api/instances/:id/snapshots/:sid ------------------------------

  describe("DELETE .../snapshots/:sid", () => {
    it("deletes a snapshot", async () => {
      snapshotManagerMock.get.mockReturnValue(mockSnapshot);
      snapshotManagerMock.delete.mockResolvedValue(true);

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1", {
        method: "DELETE",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(204);
    });

    it("returns 404 for missing snapshot", async () => {
      snapshotManagerMock.get.mockReturnValue(null);

      const res = await app.request("/api/instances/inst-1/snapshots/missing", {
        method: "DELETE",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when snapshot belongs to different instance", async () => {
      snapshotManagerMock.get.mockReturnValue({ ...mockSnapshot, instanceId: "inst-other" });

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1", {
        method: "DELETE",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(403);
    });
  });

});
