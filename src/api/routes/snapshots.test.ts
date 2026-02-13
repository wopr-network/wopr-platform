import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Set env vars BEFORE importing snapshot routes
const TEST_TOKEN = "test-api-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);
vi.stubEnv("SNAPSHOT_DB_PATH", ":memory:");
vi.stubEnv("SNAPSHOT_DIR", "/tmp/test-snapshots");
vi.stubEnv("WOPR_HOME_BASE", "/tmp/test-instances");

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// --- Mock SnapshotManager ---

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

const managerMock = {
  create: vi.fn(),
  restore: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
  getOldest: vi.fn(),
};

class MockSnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`Snapshot not found: ${id}`);
    this.name = "SnapshotNotFoundError";
  }
}

vi.mock("better-sqlite3", () => {
  return { default: class MockDatabase {} };
});

vi.mock("../../backup/snapshot-manager.js", () => {
  return {
    SnapshotManager: class {
      create = managerMock.create;
      restore = managerMock.restore;
      get = managerMock.get;
      list = managerMock.list;
      delete = managerMock.delete;
      count = managerMock.count;
      getOldest = managerMock.getOldest;
    },
    SnapshotNotFoundError: MockSnapshotNotFoundError,
  };
});

vi.mock("../../backup/schema.js", () => {
  return { initSnapshotSchema: vi.fn() };
});

vi.mock("../../backup/retention.js", () => {
  return { enforceRetention: vi.fn().mockResolvedValue(0) };
});

// Import AFTER mocks
const { snapshotRoutes } = await import("./snapshots.js");

// Mount under the same path pattern as app.ts
const app = new Hono();
app.route("/api/instances/:id/snapshots", snapshotRoutes);

describe("snapshot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("rejects requests without bearer token", async () => {
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

  describe("POST /api/instances/:id/snapshots", () => {
    it("creates a snapshot", async () => {
      managerMock.create.mockResolvedValue(mockSnapshot);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ trigger: "manual" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("snap-1");
      expect(body.instanceId).toBe("inst-1");
    });

    it("creates a snapshot with empty body (defaults to manual)", async () => {
      managerMock.create.mockResolvedValue(mockSnapshot);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(201);
    });

    it("rejects scheduled trigger on free tier", async () => {
      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tier": "free", ...authHeader },
        body: JSON.stringify({ trigger: "scheduled" }),
      });

      expect(res.status).toBe(403);
    });

    it("allows scheduled trigger on pro tier", async () => {
      managerMock.create.mockResolvedValue(mockSnapshot);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tier": "pro", ...authHeader },
        body: JSON.stringify({ trigger: "scheduled" }),
      });

      expect(res.status).toBe(201);
    });

    it("returns 400 on invalid JSON", async () => {
      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json{{{",
      });

      expect(res.status).toBe(400);
    });

    it("returns 500 on manager error", async () => {
      managerMock.create.mockRejectedValue(new Error("tar failed"));

      const res = await app.request("/api/instances/inst-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ trigger: "manual" }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/instances/:id/snapshots", () => {
    it("lists snapshots for an instance", async () => {
      managerMock.list.mockReturnValue([mockSnapshot]);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toHaveLength(1);
      expect(body.snapshots[0].id).toBe("snap-1");
    });

    it("returns empty list when no snapshots", async () => {
      managerMock.list.mockReturnValue([]);

      const res = await app.request("/api/instances/inst-1/snapshots", {
        headers: authHeader,
      });

      const body = await res.json();
      expect(body.snapshots).toEqual([]);
    });
  });

  describe("POST /api/instances/:id/snapshots/:sid/restore", () => {
    it("restores from snapshot", async () => {
      managerMock.get.mockReturnValue(mockSnapshot);
      managerMock.restore.mockResolvedValue(undefined);

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1/restore", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.restored).toBe("snap-1");
    });

    it("returns 404 for missing snapshot", async () => {
      managerMock.get.mockReturnValue(null);

      const res = await app.request("/api/instances/inst-1/snapshots/missing/restore", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns 403 when snapshot belongs to different instance", async () => {
      managerMock.get.mockReturnValue({ ...mockSnapshot, instanceId: "inst-other" });

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1/restore", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(403);
    });

    it("returns 500 on restore failure", async () => {
      managerMock.get.mockReturnValue(mockSnapshot);
      managerMock.restore.mockRejectedValue(new Error("tar extract failed"));

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1/restore", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /api/instances/:id/snapshots/:sid", () => {
    it("deletes a snapshot", async () => {
      managerMock.get.mockReturnValue(mockSnapshot);
      managerMock.delete.mockResolvedValue(true);

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(204);
    });

    it("returns 404 for missing snapshot", async () => {
      managerMock.get.mockReturnValue(null);

      const res = await app.request("/api/instances/inst-1/snapshots/missing", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns 403 when snapshot belongs to different instance", async () => {
      managerMock.get.mockReturnValue({ ...mockSnapshot, instanceId: "inst-other" });

      const res = await app.request("/api/instances/inst-1/snapshots/snap-1", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(403);
    });
  });
});
