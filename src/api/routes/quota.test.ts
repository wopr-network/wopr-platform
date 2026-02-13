import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Set env var BEFORE importing quota routes so bearer auth uses this token
const TEST_TOKEN = "test-quota-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// Import AFTER env stub
const { quotaRoutes, setTierStore } = await import("./quota.js");
const { TierStore } = await import("../../monetization/quotas/tier-definitions.js");

describe("quota routes", () => {
  let db: Database.Database;
  let store: InstanceType<typeof TierStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new TierStore(db);
    store.seed();
    setTierStore(store);
  });

  afterEach(() => {
    db.close();
  });

  describe("authentication", () => {
    it("rejects requests without bearer token", async () => {
      const res = await quotaRoutes.request("/");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await quotaRoutes.request("/", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /", () => {
    it("returns quota usage for free tier", async () => {
      const res = await quotaRoutes.request("/?tier=free&activeInstances=0", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier.name).toBe("free");
      expect(body.instances.current).toBe(0);
      expect(body.instances.max).toBe(1);
      expect(body.instances.remaining).toBe(1);
    });

    it("defaults to free tier when no tier specified", async () => {
      const res = await quotaRoutes.request("/", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier.name).toBe("free");
    });

    it("returns 404 for unknown tier", async () => {
      const res = await quotaRoutes.request("/?tier=nonexistent", { headers: authHeader });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid activeInstances", async () => {
      const res = await quotaRoutes.request("/?activeInstances=abc", { headers: authHeader });
      expect(res.status).toBe(400);
    });

    it("shows remaining=-1 for unlimited tier", async () => {
      const res = await quotaRoutes.request("/?tier=enterprise&activeInstances=50", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.instances.remaining).toBe(-1);
    });
  });

  describe("POST /check", () => {
    it("allows when under quota", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "free", activeInstances: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
    });

    it("rejects when at quota (403)", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "free", activeInstances: 1 }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.allowed).toBe(false);
      expect(body.reason).toContain("quota exceeded");
    });

    it("allows with soft cap enabled", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "free", activeInstances: 1, softCap: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
      expect(body.inGracePeriod).toBe(true);
    });

    it("returns 404 for unknown tier", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "nonexistent", activeInstances: 0 }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /tiers", () => {
    it("lists all tiers", async () => {
      const res = await quotaRoutes.request("/tiers", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tiers).toHaveLength(4);
    });
  });

  describe("GET /tiers/:id", () => {
    it("returns a specific tier", async () => {
      const res = await quotaRoutes.request("/tiers/pro", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("pro");
      expect(body.maxInstances).toBe(5);
    });

    it("returns 404 for unknown tier", async () => {
      const res = await quotaRoutes.request("/tiers/unknown", { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /resource-limits/:tierId", () => {
    it("returns Docker resource limits for a tier", async () => {
      const res = await quotaRoutes.request("/resource-limits/free", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.Memory).toBe(512 * 1024 * 1024);
      expect(body.CpuQuota).toBe(50_000);
      expect(body.PidsLimit).toBe(128);
    });

    it("returns 404 for unknown tier", async () => {
      const res = await quotaRoutes.request("/resource-limits/nonexistent", { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });
});
