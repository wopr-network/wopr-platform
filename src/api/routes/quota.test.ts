import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { DrizzleCreditRepository } from "../../infrastructure/persistence/drizzle-credit-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import { Money } from "../../domain/value-objects/money.js";
import type { CreditRepository } from "../../domain/repositories/credit-repository.js";
import { initCreditSchema } from "../../monetization/credits/schema.js";

// Set env var BEFORE importing quota routes so bearer auth uses this token
const TEST_TOKEN = "test-quota-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };
const jsonAuth = { "Content-Type": "application/json", ...authHeader };

// Import AFTER env stub
const { quotaRoutes, setLedger } = await import("./quota.js");

describe("quota routes", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let creditRepo: CreditRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initCreditSchema(sqlite);
    db = createDb(sqlite);
    creditRepo = new DrizzleCreditRepository(db);
    setLedger(creditRepo);
  });

  afterEach(() => {
    sqlite.close();
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
    it("returns zero balance and default instance limits for new tenant", async () => {
      const res = await quotaRoutes.request("/?tenant=t-1&activeInstances=0", {
        headers: authHeader,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceCents).toBe(0);
      expect(body.instances.current).toBe(0);
      // Default maxInstances=0 means unlimited, remaining=-1
      expect(body.instances.remaining).toBe(-1);
    });

    it("returns balance for tenant with credits", async () => {
      await creditRepo.credit(TenantId.create("t-1"), Money.fromCents(5000), "purchase", "test");
      const res = await quotaRoutes.request("/?tenant=t-1&activeInstances=2", {
        headers: authHeader,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceCents).toBe(5000);
      expect(body.instances.current).toBe(2);
    });

    it("returns 400 when tenant is missing", async () => {
      const res = await quotaRoutes.request("/", { headers: authHeader });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid activeInstances", async () => {
      const res = await quotaRoutes.request("/?tenant=t-1&activeInstances=abc", {
        headers: authHeader,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /check", () => {
    it("returns 402 when tenant has zero balance", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ tenant: "t-1", activeInstances: 0 }),
      });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.allowed).toBe(false);
      expect(body.reason).toContain("Insufficient credit balance");
    });

    it("allows when tenant has positive balance", async () => {
      await creditRepo.credit(TenantId.create("t-1"), Money.fromCents(1000), "purchase", "test");
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ tenant: "t-1", activeInstances: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: jsonAuth,
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when tenant is missing", async () => {
      const res = await quotaRoutes.request("/check", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ activeInstances: 0 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /balance/:tenant", () => {
    it("returns zero for unknown tenant", async () => {
      const res = await quotaRoutes.request("/balance/t-new", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe("t-new");
      expect(body.balanceCents).toBe(0);
    });

    it("returns current balance for tenant with credits", async () => {
      await creditRepo.credit(TenantId.create("t-1"), Money.fromCents(2500), "purchase", "test purchase");
      const res = await quotaRoutes.request("/balance/t-1", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceCents).toBe(2500);
    });
  });

  describe("GET /history/:tenant", () => {
    it("returns empty array for unknown tenant", async () => {
      const res = await quotaRoutes.request("/history/t-new", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transactions).toEqual([]);
    });

    it("returns transaction history", async () => {
      await creditRepo.credit(TenantId.create("t-1"), Money.fromCents(1000), "purchase", "first purchase");
      await creditRepo.credit(TenantId.create("t-1"), Money.fromCents(500), "signup_grant", "welcome bonus");

      const res = await quotaRoutes.request("/history/t-1", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transactions).toHaveLength(2);
    });

    it("supports type filter", async () => {
      await creditRepo.credit(TenantId.create("t-1"), Money.fromCents(1000), "purchase", "purchase");
      await creditRepo.credit(TenantId.create("t-1"), Money.fromCents(500), "signup_grant", "grant");

      const res = await quotaRoutes.request("/history/t-1?type=purchase", {
        headers: authHeader,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transactions).toHaveLength(1);
      expect(body.transactions[0].type).toBe("purchase");
    });
  });

  describe("GET /resource-limits", () => {
    it("returns default Docker resource limits", async () => {
      const res = await quotaRoutes.request("/resource-limits", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.Memory).toBeDefined();
      expect(body.CpuQuota).toBeDefined();
      expect(body.PidsLimit).toBeDefined();
    });
  });
});
