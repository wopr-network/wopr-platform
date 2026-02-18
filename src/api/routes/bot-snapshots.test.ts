import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Set env vars BEFORE importing the routes
const TEST_TOKEN = "test-bot-api-token";
vi.stubEnv("FLEET_TOKEN_tenant-a", `write:${TEST_TOKEN}`);
vi.stubEnv("FLEET_TOKEN_tenant-b", `write:other-token`);
vi.stubEnv("WOPR_HOME_BASE", "/tmp/test-instances");

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// ---- Mocks ------------------------------------------------------------------

const mockSnapshot = {
  id: "snap-1",
  tenant: "tenant-a",
  instanceId: "bot-1",
  userId: "user-1",
  name: null,
  type: "on-demand" as const,
  s3Key: null,
  sizeMb: 200,
  sizeBytes: 200 * 1024 * 1024,
  nodeId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  deletedAt: null,
  trigger: "manual" as const,
  plugins: [],
  configHash: "",
  storagePath: "/data/snapshots/snap-1.tar.gz",
};

const serviceMock = {
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

class MockInsufficientCreditsError extends Error {
  balance: number;
  constructor(balance: number) {
    super(`Insufficient credit balance: ${balance} cents`);
    this.name = "InsufficientCreditsError";
    this.balance = balance;
  }
}

class MockSnapshotQuotaExceededError extends Error {
  current: number;
  max: number;
  tier: string;
  constructor(current: number, max: number, tier: string) {
    super(`On-demand snapshot limit reached: ${current}/${max} (${tier} tier)`);
    this.name = "SnapshotQuotaExceededError";
    this.current = current;
    this.max = max;
    this.tier = tier;
  }
}

vi.mock("../../backup/on-demand-snapshot-service.js", () => {
  return {
    OnDemandSnapshotService: class {
      create = serviceMock.create;
      delete = serviceMock.delete;
      list = serviceMock.list;
    },
    InsufficientCreditsError: MockInsufficientCreditsError,
    SnapshotQuotaExceededError: MockSnapshotQuotaExceededError,
  };
});

// Import AFTER mocks
const { botSnapshotRoutes, setService } = await import("./bot-snapshots.js");

// Mount the routes under the expected path pattern
const app = new Hono();
app.route("/api/bots/:id/snapshots", botSnapshotRoutes);

describe("bot snapshot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Inject the mocked service
    setService({
      create: serviceMock.create,
      delete: serviceMock.delete,
      list: serviceMock.list,
    } as never);
  });

  // ---------- POST /api/bots/:id/snapshots ----------

  describe("POST /api/bots/:id/snapshots", () => {
    it("creates snapshot, returns 201 with cost estimate", async () => {
      serviceMock.create.mockResolvedValue({
        snapshot: mockSnapshot,
        estimatedMonthlyCostCents: 1,
      });

      const res = await app.request("/api/bots/bot-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "pre-deploy" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.snapshot.id).toBe("snap-1");
      expect(body.estimatedMonthlyCost).toContain("$");
    });

    it("returns 402 when no credits", async () => {
      serviceMock.create.mockRejectedValue(new MockInsufficientCreditsError(0));

      const res = await app.request("/api/bots/bot-1/snapshots", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("insufficient_credits");
      expect(body.buyUrl).toBeDefined();
    });

    it("returns 403 when quota exceeded", async () => {
      serviceMock.create.mockRejectedValue(new MockSnapshotQuotaExceededError(1, 1, "free"));

      const res = await app.request("/api/bots/bot-1/snapshots", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("snapshot_quota_exceeded");
      expect(body.current).toBe(1);
      expect(body.max).toBe(1);
    });

    it("returns 400 for invalid bot ID (path traversal)", async () => {
      const res = await app.request("/api/bots/..%2Fetc/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect([400, 404]).toContain(res.status);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await app.request("/api/bots/bot-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not-json{{{",
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid tier header", async () => {
      const res = await app.request("/api/bots/bot-1/snapshots", {
        method: "POST",
        headers: { ...authHeader, "X-Tier": "invalid-tier" },
      });

      expect(res.status).toBe(400);
    });

    it("returns 500 on unexpected manager error", async () => {
      serviceMock.create.mockRejectedValue(new Error("unexpected failure"));

      const res = await app.request("/api/bots/bot-1/snapshots", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(500);
    });

    it("returns 401 without auth token", async () => {
      const res = await app.request("/api/bots/bot-1/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
    });
  });

  // ---------- GET /api/bots/:id/snapshots ----------

  describe("GET /api/bots/:id/snapshots", () => {
    it("lists snapshots for tenant's bot", async () => {
      serviceMock.list.mockReturnValue([mockSnapshot]);

      const res = await app.request("/api/bots/bot-1/snapshots", {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toHaveLength(1);
      expect(body.snapshots[0].id).toBe("snap-1");
    });

    it("returns empty list when no snapshots", async () => {
      serviceMock.list.mockReturnValue([]);

      const res = await app.request("/api/bots/bot-1/snapshots", {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toEqual([]);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/api/bots/bot-1/snapshots");
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid bot ID", async () => {
      const res = await app.request("/api/bots/bot%20bad/snapshots", {
        headers: authHeader,
      });
      expect(res.status).toBe(400);
    });
  });

  // ---------- DELETE /api/bots/:id/snapshots/:snapId ----------

  describe("DELETE /api/bots/:id/snapshots/:snapId", () => {
    it("returns 204 on success", async () => {
      serviceMock.delete.mockResolvedValue(true);

      const res = await app.request("/api/bots/bot-1/snapshots/snap-1", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(204);
    });

    it("returns 404 for missing snapshot", async () => {
      serviceMock.delete.mockResolvedValue(false);

      const res = await app.request("/api/bots/bot-1/snapshots/missing", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns 403 for nightly snapshots", async () => {
      serviceMock.delete.mockRejectedValue(new Error("Only on-demand snapshots can be deleted by the tenant"));

      const res = await app.request("/api/bots/bot-1/snapshots/nightly-snap", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("on-demand");
    });

    it("returns 400 for invalid snapshot ID", async () => {
      const res = await app.request("/api/bots/bot-1/snapshots/bad%20id", {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
    });
  });
});
