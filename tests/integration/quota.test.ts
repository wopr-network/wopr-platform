/**
 * Integration tests for /api/quota/* routes.
 *
 * Tests quota endpoints through the full composed Hono app with
 * real bearer auth middleware and in-memory SQLite tier store.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";

const { app } = await import("../../src/api/app.js");
const { setTierStore } = await import("../../src/api/routes/quota.js");
const { TierStore } = await import("../../src/monetization/quotas/tier-definitions.js");

describe("integration: quota routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(":memory:");
    const store = new TierStore(db);
    store.seed();
    setTierStore(store);
  });

  afterEach(() => {
    db.close();
  });

  // -- Authentication -------------------------------------------------------

  describe("auth middleware", () => {
    it("rejects GET /api/quota without token", async () => {
      const res = await app.request("/api/quota");
      expect(res.status).toBe(401);
    });

    it("rejects GET /api/quota with wrong token", async () => {
      const res = await app.request("/api/quota", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -- GET /api/quota -------------------------------------------------------

  describe("GET /api/quota", () => {
    it("returns quota usage for free tier", async () => {
      const res = await app.request("/api/quota?tier=free&activeInstances=0", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier.name).toBe("free");
      expect(body.instances.current).toBe(0);
      expect(body.instances.max).toBe(1);
    });

    it("defaults to free tier when no tier specified", async () => {
      const res = await app.request("/api/quota", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier.name).toBe("free");
    });

    it("returns 404 for unknown tier", async () => {
      const res = await app.request("/api/quota?tier=nonexistent", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid activeInstances", async () => {
      const res = await app.request("/api/quota?activeInstances=abc", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(400);
    });
  });

  // -- POST /api/quota/check ------------------------------------------------

  describe("POST /api/quota/check", () => {
    it("allows when under quota (200)", async () => {
      const res = await app.request("/api/quota/check", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tier: "free", activeInstances: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
    });

    it("rejects when at quota (403)", async () => {
      const res = await app.request("/api/quota/check", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tier: "free", activeInstances: 1 }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.allowed).toBe(false);
    });

    it("allows with soft cap enabled", async () => {
      const res = await app.request("/api/quota/check", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tier: "free", activeInstances: 1, softCap: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
      expect(body.inGracePeriod).toBe(true);
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await app.request("/api/quota/check", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // -- GET /api/quota/tiers -------------------------------------------------

  describe("GET /api/quota/tiers", () => {
    it("lists all tiers", async () => {
      const res = await app.request("/api/quota/tiers", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tiers).toHaveLength(4);
    });
  });

  // -- GET /api/quota/tiers/:id ---------------------------------------------

  describe("GET /api/quota/tiers/:id", () => {
    it("returns a specific tier", async () => {
      const res = await app.request("/api/quota/tiers/pro", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("pro");
    });

    it("returns 404 for unknown tier", async () => {
      const res = await app.request("/api/quota/tiers/unknown", { headers: AUTH_HEADER });
      expect(res.status).toBe(404);
    });
  });

  // -- GET /api/quota/resource-limits/:tierId --------------------------------

  describe("GET /api/quota/resource-limits/:tierId", () => {
    it("returns Docker resource limits for a tier", async () => {
      const res = await app.request("/api/quota/resource-limits/free", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.Memory).toBe(512 * 1024 * 1024);
      expect(body.CpuQuota).toBe(50_000);
    });

    it("returns 404 for unknown tier", async () => {
      const res = await app.request("/api/quota/resource-limits/nonexistent", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(404);
    });
  });
});
