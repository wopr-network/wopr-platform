/**
 * Integration tests for /api/quota/* routes.
 *
 * Tests quota endpoints through the full composed Hono app with
 * real bearer auth middleware and in-memory PGlite credit ledger.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS } from "./setup.js";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";

const { app } = await import("../../src/api/app.js");
const { setLedger } = await import("../../src/api/routes/quota.js");
const { CreditLedger } = await import("../../src/monetization/credits/credit-ledger.js");

describe("integration: quota routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: InstanceType<typeof CreditLedger>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
    setLedger(ledger);
  });

  afterEach(async () => {
    await pool.close();
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
    it("returns zero balance for new tenant", async () => {
      const res = await app.request("/api/quota?tenant=t-1&activeInstances=0", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceCents).toBe(0);
      expect(body.instances.current).toBe(0);
    });

    it("returns balance for tenant with credits", async () => {
      await ledger.credit("t-1", 5000, "purchase", "test");
      const res = await app.request("/api/quota?tenant=t-1&activeInstances=2", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceCents).toBe(5000);
      expect(body.instances.current).toBe(2);
    });

    it("returns 400 when tenant is missing", async () => {
      const res = await app.request("/api/quota", { headers: AUTH_HEADER });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid activeInstances", async () => {
      const res = await app.request("/api/quota?tenant=t-1&activeInstances=abc", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(400);
    });
  });

  // -- POST /api/quota/check ------------------------------------------------

  describe("POST /api/quota/check", () => {
    it("returns 402 when tenant has no credits", async () => {
      const res = await app.request("/api/quota/check", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tenant: "t-1", activeInstances: 0 }),
      });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.allowed).toBe(false);
    });

    it("allows when tenant has positive balance (200)", async () => {
      await ledger.credit("t-1", 1000, "purchase", "test");
      const res = await app.request("/api/quota/check", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ tenant: "t-1", activeInstances: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
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

  // -- GET /api/quota/balance/:tenant ----------------------------------------

  describe("GET /api/quota/balance/:tenant", () => {
    it("returns zero for unknown tenant", async () => {
      const res = await app.request("/api/quota/balance/t-new", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe("t-new");
      expect(body.balanceCents).toBe(0);
    });

    it("returns balance for tenant with credits", async () => {
      await ledger.credit("t-1", 2500, "purchase", "test purchase");
      const res = await app.request("/api/quota/balance/t-1", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceCents).toBe(2500);
    });
  });

  // -- GET /api/quota/history/:tenant ----------------------------------------

  describe("GET /api/quota/history/:tenant", () => {
    it("returns empty for unknown tenant", async () => {
      const res = await app.request("/api/quota/history/t-new", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transactions).toEqual([]);
    });

    it("returns transaction history", async () => {
      await ledger.credit("t-1", 1000, "purchase", "first");
      await ledger.credit("t-1", 500, "signup_grant", "welcome");

      const res = await app.request("/api/quota/history/t-1", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transactions).toHaveLength(2);
    });
  });

  // -- GET /api/quota/resource-limits ----------------------------------------

  describe("GET /api/quota/resource-limits", () => {
    it("returns default Docker resource limits", async () => {
      const res = await app.request("/api/quota/resource-limits", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.Memory).toBeDefined();
      expect(body.CpuQuota).toBeDefined();
      expect(body.PidsLimit).toBeDefined();
    });
  });
});
