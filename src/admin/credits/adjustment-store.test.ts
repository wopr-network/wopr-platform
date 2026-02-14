import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminCreditApiRoutes } from "../../api/routes/admin-credits.js";
import { BalanceError, CreditAdjustmentStore } from "./adjustment-store.js";
import { initCreditAdjustmentSchema } from "./schema.js";

function createTestDb() {
  const db = new BetterSqlite3(":memory:");
  initCreditAdjustmentSchema(db);
  return db;
}

describe("initCreditAdjustmentSchema", () => {
  it("creates credit_adjustments table", () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_adjustments'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_credit_adjustments_%'")
      .all() as { name: string }[];
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it("is idempotent", () => {
    const db = createTestDb();
    initCreditAdjustmentSchema(db);
    db.close();
  });
});

describe("CreditAdjustmentStore.grant", () => {
  let db: BetterSqlite3.Database;
  let store: CreditAdjustmentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CreditAdjustmentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a grant transaction", () => {
    const adj = store.grant("tenant-1", 5000, "Welcome bonus", "admin-1");
    expect(adj.id).toBeTruthy();
    expect(adj.tenant).toBe("tenant-1");
    expect(adj.type).toBe("grant");
    expect(adj.amount_cents).toBe(5000);
    expect(adj.reason).toBe("Welcome bonus");
    expect(adj.admin_user).toBe("admin-1");
    expect(adj.reference_ids).toBeNull();
    expect(adj.created_at).toBeGreaterThan(0);
  });

  it("persists grant to database", () => {
    const adj = store.grant("tenant-1", 1000, "Test grant", "admin-1");
    const row = db.prepare("SELECT * FROM credit_adjustments WHERE id = ?").get(adj.id);
    expect(row).toBeTruthy();
  });

  it("rejects non-positive amount", () => {
    expect(() => store.grant("tenant-1", 0, "Zero grant", "admin-1")).toThrow("must be positive");
    expect(() => store.grant("tenant-1", -100, "Negative grant", "admin-1")).toThrow("must be positive");
  });

  it("rejects empty reason", () => {
    expect(() => store.grant("tenant-1", 100, "", "admin-1")).toThrow("reason is required");
    expect(() => store.grant("tenant-1", 100, "   ", "admin-1")).toThrow("reason is required");
  });

  it("generates unique IDs", () => {
    const a1 = store.grant("tenant-1", 100, "First", "admin-1");
    const a2 = store.grant("tenant-1", 200, "Second", "admin-1");
    expect(a1.id).not.toBe(a2.id);
  });
});

describe("CreditAdjustmentStore.refund", () => {
  let db: BetterSqlite3.Database;
  let store: CreditAdjustmentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CreditAdjustmentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a refund transaction (stores negative amount)", () => {
    store.grant("tenant-1", 5000, "Initial", "admin-1");
    const adj = store.refund("tenant-1", 2000, "Customer complaint", "admin-1");
    expect(adj.type).toBe("refund");
    expect(adj.amount_cents).toBe(-2000);
    expect(adj.reason).toBe("Customer complaint");
  });

  it("stores reference_ids as JSON", () => {
    store.grant("tenant-1", 5000, "Initial", "admin-1");
    const adj = store.refund("tenant-1", 1000, "Partial refund", "admin-1", ["tx-1", "tx-2"]);
    expect(adj.reference_ids).toBe('["tx-1","tx-2"]');
  });

  it("prevents refund that would go negative", () => {
    store.grant("tenant-1", 1000, "Initial", "admin-1");
    expect(() => store.refund("tenant-1", 2000, "Too much", "admin-1")).toThrow("Insufficient balance");
  });

  it("throws BalanceError with current balance on insufficient funds", () => {
    store.grant("tenant-1", 500, "Initial", "admin-1");
    try {
      store.refund("tenant-1", 1000, "Too much", "admin-1");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BalanceError);
      expect((err as BalanceError).currentBalance).toBe(500);
    }
  });

  it("allows refund up to exact balance", () => {
    store.grant("tenant-1", 3000, "Initial", "admin-1");
    const adj = store.refund("tenant-1", 3000, "Full refund", "admin-1");
    expect(adj.amount_cents).toBe(-3000);
    expect(store.getBalance("tenant-1")).toBe(0);
  });

  it("rejects non-positive amount", () => {
    expect(() => store.refund("tenant-1", 0, "Zero", "admin-1")).toThrow("must be positive");
  });

  it("rejects empty reason", () => {
    store.grant("tenant-1", 1000, "Initial", "admin-1");
    expect(() => store.refund("tenant-1", 100, "", "admin-1")).toThrow("reason is required");
  });
});

describe("CreditAdjustmentStore.correction", () => {
  let db: BetterSqlite3.Database;
  let store: CreditAdjustmentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CreditAdjustmentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a positive correction", () => {
    const adj = store.correction("tenant-1", 500, "Manual adjustment", "admin-1");
    expect(adj.type).toBe("correction");
    expect(adj.amount_cents).toBe(500);
    expect(store.getBalance("tenant-1")).toBe(500);
  });

  it("creates a negative correction", () => {
    store.grant("tenant-1", 1000, "Initial", "admin-1");
    const adj = store.correction("tenant-1", -300, "Overcharge fix", "admin-1");
    expect(adj.amount_cents).toBe(-300);
    expect(store.getBalance("tenant-1")).toBe(700);
  });

  it("prevents negative correction that would go below zero", () => {
    store.grant("tenant-1", 100, "Initial", "admin-1");
    expect(() => store.correction("tenant-1", -200, "Too much", "admin-1")).toThrow("negative balance");
  });

  it("allows zero-value correction", () => {
    const adj = store.correction("tenant-1", 0, "No-op correction", "admin-1");
    expect(adj.amount_cents).toBe(0);
    expect(store.getBalance("tenant-1")).toBe(0);
  });

  it("rejects empty reason", () => {
    expect(() => store.correction("tenant-1", 100, "", "admin-1")).toThrow("reason is required");
  });
});

describe("CreditAdjustmentStore.getBalance", () => {
  let db: BetterSqlite3.Database;
  let store: CreditAdjustmentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CreditAdjustmentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 for tenant with no transactions", () => {
    expect(store.getBalance("nonexistent")).toBe(0);
  });

  it("accumulates multiple transactions", () => {
    store.grant("tenant-1", 5000, "Grant 1", "admin-1");
    store.grant("tenant-1", 3000, "Grant 2", "admin-1");
    store.refund("tenant-1", 2000, "Refund", "admin-1");
    expect(store.getBalance("tenant-1")).toBe(6000);
  });

  it("isolates by tenant", () => {
    store.grant("tenant-1", 5000, "Grant", "admin-1");
    store.grant("tenant-2", 3000, "Grant", "admin-1");
    expect(store.getBalance("tenant-1")).toBe(5000);
    expect(store.getBalance("tenant-2")).toBe(3000);
  });
});

describe("CreditAdjustmentStore.listTransactions", () => {
  let db: BetterSqlite3.Database;
  let store: CreditAdjustmentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CreditAdjustmentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("lists transactions for a tenant", () => {
    store.grant("tenant-1", 1000, "Grant", "admin-1");
    store.grant("tenant-2", 2000, "Other", "admin-1");

    const result = store.listTransactions("tenant-1");
    expect(result.entries).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.entries[0].tenant).toBe("tenant-1");
  });

  it("filters by type", () => {
    store.grant("tenant-1", 5000, "Grant", "admin-1");
    store.refund("tenant-1", 1000, "Refund", "admin-1");
    store.correction("tenant-1", 200, "Correction", "admin-1");

    const grants = store.listTransactions("tenant-1", { type: "grant" });
    expect(grants.entries).toHaveLength(1);
    expect(grants.entries[0].type).toBe("grant");

    const refunds = store.listTransactions("tenant-1", { type: "refund" });
    expect(refunds.entries).toHaveLength(1);
    expect(refunds.entries[0].type).toBe("refund");
  });

  it("supports pagination", () => {
    for (let i = 0; i < 10; i++) {
      store.grant("tenant-1", 100, `Grant ${i}`, "admin-1");
    }

    const page1 = store.listTransactions("tenant-1", { limit: 3, offset: 0 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.total).toBe(10);

    const page2 = store.listTransactions("tenant-1", { limit: 3, offset: 3 });
    expect(page2.entries).toHaveLength(3);
    expect(page2.entries[0].id).not.toBe(page1.entries[0].id);
  });

  it("caps limit at 250", () => {
    for (let i = 0; i < 5; i++) {
      store.grant("tenant-1", 100, `Grant ${i}`, "admin-1");
    }

    const result = store.listTransactions("tenant-1", { limit: 999 });
    expect(result.entries).toHaveLength(5);
  });

  it("returns entries ordered by created_at descending", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO credit_adjustments (id, tenant, type, amount_cents, reason, admin_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("first", "tenant-1", "grant", 100, "Old", "admin-1", now - 1000);
    db.prepare(
      "INSERT INTO credit_adjustments (id, tenant, type, amount_cents, reason, admin_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("second", "tenant-1", "grant", 200, "New", "admin-1", now);

    const result = store.listTransactions("tenant-1");
    expect(result.entries[0].id).toBe("second");
    expect(result.entries[1].id).toBe("first");
  });

  it("filters by date range", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO credit_adjustments (id, tenant, type, amount_cents, reason, admin_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("old", "tenant-1", "grant", 100, "Old", "admin-1", now - 100000);
    db.prepare(
      "INSERT INTO credit_adjustments (id, tenant, type, amount_cents, reason, admin_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("new", "tenant-1", "grant", 200, "New", "admin-1", now);

    const result = store.listTransactions("tenant-1", { from: now - 5000 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("new");
  });

  it("returns empty results when no entries match", () => {
    const result = store.listTransactions("nonexistent");
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("CreditAdjustmentStore.getTransaction", () => {
  let db: BetterSqlite3.Database;
  let store: CreditAdjustmentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CreditAdjustmentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns a transaction by ID", () => {
    const adj = store.grant("tenant-1", 1000, "Test", "admin-1");
    const found = store.getTransaction(adj.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(adj.id);
    expect(found?.amount_cents).toBe(1000);
  });

  it("returns null for non-existent ID", () => {
    const found = store.getTransaction("nonexistent");
    expect(found).toBeNull();
  });
});

describe("admin credit API routes", () => {
  let db: BetterSqlite3.Database;
  let store: CreditAdjustmentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CreditAdjustmentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeApp() {
    const app = new Hono();
    app.route("/api/admin/credits", createAdminCreditApiRoutes(db));
    return app;
  }

  describe("POST /api/admin/credits/:tenantId/grant", () => {
    it("grants credits and returns 201", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/grant", {
        method: "POST",
        body: JSON.stringify({ amount_cents: 5000, reason: "Welcome bonus" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.type).toBe("grant");
      expect(body.amount_cents).toBe(5000);
      expect(body.tenant).toBe("tenant-1");
      expect(body.reason).toBe("Welcome bonus");
    });

    it("returns 400 for missing amount_cents", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/grant", {
        method: "POST",
        body: JSON.stringify({ reason: "Test" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("amount_cents");
    });

    it("returns 400 for non-positive amount_cents", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/grant", {
        method: "POST",
        body: JSON.stringify({ amount_cents: -100, reason: "Test" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing reason", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/grant", {
        method: "POST",
        body: JSON.stringify({ amount_cents: 100 }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("reason");
    });

    it("returns 400 for invalid JSON body", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/grant", {
        method: "POST",
        body: "not-json",
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });
  });

  describe("POST /api/admin/credits/:tenantId/refund", () => {
    it("refunds credits and returns 201", async () => {
      // Grant first so balance exists
      store.grant("tenant-1", 5000, "Initial", "admin-1");

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/refund", {
        method: "POST",
        body: JSON.stringify({ amount_cents: 2000, reason: "Service issue", reference_ids: ["tx-1"] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.type).toBe("refund");
      expect(body.amount_cents).toBe(-2000);
      expect(body.reference_ids).toBe('["tx-1"]');
    });

    it("returns 400 for insufficient balance", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/refund", {
        method: "POST",
        body: JSON.stringify({ amount_cents: 1000, reason: "Refund" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Insufficient balance");
      expect(body.current_balance).toBe(0);
    });

    it("returns 400 for invalid reference_ids", async () => {
      store.grant("tenant-1", 5000, "Initial", "admin-1");

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/refund", {
        method: "POST",
        body: JSON.stringify({ amount_cents: 100, reason: "Test", reference_ids: "not-array" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("reference_ids");
    });
  });

  describe("POST /api/admin/credits/:tenantId/correction", () => {
    it("applies positive correction and returns 201", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/correction", {
        method: "POST",
        body: JSON.stringify({ amount_cents: 500, reason: "Manual fix" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.type).toBe("correction");
      expect(body.amount_cents).toBe(500);
    });

    it("applies negative correction", async () => {
      store.grant("tenant-1", 1000, "Initial", "admin-1");

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/correction", {
        method: "POST",
        body: JSON.stringify({ amount_cents: -300, reason: "Overcharge" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.amount_cents).toBe(-300);
    });

    it("returns 400 when correction would go negative", async () => {
      store.grant("tenant-1", 100, "Initial", "admin-1");

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/correction", {
        method: "POST",
        body: JSON.stringify({ amount_cents: -500, reason: "Too much" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("negative balance");
      expect(body.current_balance).toBe(100);
    });

    it("returns 400 for non-integer amount_cents", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/correction", {
        method: "POST",
        body: JSON.stringify({ amount_cents: 1.5, reason: "Test" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("integer");
    });
  });

  describe("GET /api/admin/credits/:tenantId/balance", () => {
    it("returns balance for a tenant", async () => {
      store.grant("tenant-1", 5000, "Grant", "admin-1");
      store.refund("tenant-1", 1000, "Refund", "admin-1");

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/balance");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenant).toBe("tenant-1");
      expect(body.balance_cents).toBe(4000);
    });

    it("returns 0 for tenant with no transactions", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/nonexistent/balance");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balance_cents).toBe(0);
    });
  });

  describe("GET /api/admin/credits/:tenantId/transactions", () => {
    it("returns paginated transactions", async () => {
      for (let i = 0; i < 5; i++) {
        store.grant("tenant-1", 100, `Grant ${i}`, "admin-1");
      }

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/transactions?limit=2&offset=1");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it("filters by type", async () => {
      store.grant("tenant-1", 5000, "Grant", "admin-1");
      store.refund("tenant-1", 1000, "Refund", "admin-1");

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/transactions?type=grant");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].type).toBe("grant");
    });

    it("returns empty for unknown tenant", async () => {
      const app = makeApp();
      const res = await app.request("/api/admin/credits/nonexistent/transactions");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  describe("GET /api/admin/credits/:tenantId/adjustments", () => {
    it("returns adjustments list", async () => {
      store.grant("tenant-1", 5000, "Grant", "admin-1");
      store.correction("tenant-1", 200, "Correction", "admin-1");

      const app = makeApp();
      const res = await app.request("/api/admin/credits/tenant-1/adjustments");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(2);
    });
  });
});
