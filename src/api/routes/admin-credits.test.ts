import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../fleet/services.js", () => ({
  getAdminAuditLog: vi.fn().mockReturnValue({ log: vi.fn() }),
  getCreditLedger: vi.fn(),
}));

import { DrizzleCreditLedger } from "../../monetization/credits/credit-ledger.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { createAdminCreditApiRoutes } from "./admin-credits.js";

describe("admin-credits routes", () => {
  let pool: PGlite;
  let ledger: DrizzleCreditLedger;
  let app: ReturnType<typeof createAdminCreditApiRoutes>;

  beforeAll(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    ledger = new DrizzleCreditLedger(db);
    app = createAdminCreditApiRoutes(ledger);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  // POST /:tenantId/grant

  describe("POST /:tenantId/grant", () => {
    it("grants credits and returns 201", async () => {
      const res = await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 500, reason: "signup bonus" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("tenantId", "tenant-a");
    });

    it("balance increases after grant", async () => {
      await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 500, reason: "signup bonus" }),
      });
      const balRes = await app.request("/tenant-a/balance");
      const bal = await balRes.json();
      // balance_cents is a Credit serialized as raw nanodollar units
      expect(bal.balance_cents).toBeGreaterThan(0);
    });

    it("rejects non-integer amount_cents with 400", async () => {
      const res = await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 10.5, reason: "test" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/amount_cents/);
    });

    it("rejects negative amount_cents with 400", async () => {
      const res = await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: -100, reason: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects zero amount_cents with 400", async () => {
      const res = await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 0, reason: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing reason with 400", async () => {
      const res = await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 100 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/reason/);
    });

    it("rejects empty reason with 400", async () => {
      const res = await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, reason: "   " }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body with 400", async () => {
      const res = await app.request("/tenant-a/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{",
      });
      expect(res.status).toBe(400);
    });
  });

  // POST /:tenantId/refund

  describe("POST /:tenantId/refund", () => {
    it("refunds credits and returns 201", async () => {
      // Fund first so refund has something to credit
      await app.request("/tenant-b/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 1000, reason: "purchase" }),
      });

      const res = await app.request("/tenant-b/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 200, reason: "customer request" }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects negative amount_cents with 400", async () => {
      const res = await app.request("/tenant-b/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: -50, reason: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing reason with 400", async () => {
      const res = await app.request("/tenant-b/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 100 }),
      });
      expect(res.status).toBe(400);
    });
  });

  // POST /:tenantId/correction

  describe("POST /:tenantId/correction", () => {
    it("applies positive correction and returns 201", async () => {
      const res = await app.request("/tenant-c/correction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, reason: "manual correction" }),
      });
      expect(res.status).toBe(201);
    });

    it("applies negative correction (debit) when balance is sufficient", async () => {
      // Grant first to ensure sufficient balance
      await app.request("/tenant-c/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 500, reason: "setup" }),
      });

      const res = await app.request("/tenant-c/correction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: -100, reason: "correction" }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects non-integer amount_cents with 400", async () => {
      const res = await app.request("/tenant-c/correction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 10.5, reason: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing reason with 400", async () => {
      const res = await app.request("/tenant-c/correction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 50 }),
      });
      expect(res.status).toBe(400);
    });
  });

  // GET /:tenantId/balance

  describe("GET /:tenantId/balance", () => {
    it("returns zero balance for unknown tenant", async () => {
      const res = await app.request("/unknown-tenant/balance");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balance_cents).toBe(0);
      expect(body.tenant).toBe("unknown-tenant");
    });

    it("returns non-zero balance after grant", async () => {
      await app.request("/tenant-d/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 750, reason: "test" }),
      });
      const res = await app.request("/tenant-d/balance");
      expect(res.status).toBe(200);
      const body = await res.json();
      // balance_cents is a Credit serialized as raw nanodollar units
      expect(body.balance_cents).toBeGreaterThan(0);
      expect(body.tenant).toBe("tenant-d");
    });
  });

  // GET /:tenantId/transactions

  describe("GET /:tenantId/transactions", () => {
    it("returns empty entries for unknown tenant", async () => {
      const res = await app.request("/no-tenant/transactions");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns transactions after grant", async () => {
      await app.request("/tenant-e/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: 300, reason: "test" }),
      });
      const res = await app.request("/tenant-e/transactions");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0]).toHaveProperty("tenantId", "tenant-e");
    });

    it("accepts limit and offset query params", async () => {
      const res = await app.request("/tenant-e/transactions?limit=10&offset=0");
      expect(res.status).toBe(200);
    });

    it("accepts type filter query param", async () => {
      const res = await app.request("/tenant-e/transactions?type=signup_grant");
      expect(res.status).toBe(200);
    });
  });

  // GET /:tenantId/adjustments (alias for transactions)

  describe("GET /:tenantId/adjustments", () => {
    it("returns entries (alias for transactions)", async () => {
      const res = await app.request("/tenant-e/adjustments");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("entries");
      expect(body).toHaveProperty("total");
    });
  });
});
