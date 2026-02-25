import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { createAdminRateApiRoutes } from "./admin-rates.js";

/**
 * Tests for the admin rates API routes.
 *
 * Uses createAdminRateApiRoutes(db) to inject an in-memory database,
 * exercising validation branches and error paths not covered elsewhere.
 */
describe("admin rates routes", () => {
  let db: DrizzleDb;
  let sqlite: BetterSqlite3.Database;
  let app: ReturnType<typeof createAdminRateApiRoutes>;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    app = createAdminRateApiRoutes(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // ── GET / ──

  it("GET / returns combined rates list", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sell_rates: unknown[]; provider_costs: unknown[] };
    expect(body).toHaveProperty("sell_rates");
    expect(body).toHaveProperty("provider_costs");
  });

  it("GET / filters by active=true query param", async () => {
    const res = await app.request("/?active=true");
    expect(res.status).toBe(200);
  });

  it("GET / filters by active=false query param", async () => {
    const res = await app.request("/?active=false");
    expect(res.status).toBe(200);
  });

  it("GET / ignores unknown active param value", async () => {
    const res = await app.request("/?active=maybe");
    expect(res.status).toBe(200);
  });

  // ── POST /sell ──

  it("POST /sell creates a sell rate", async () => {
    const res = await app.request("/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.001 }),
    });
    expect(res.status).toBe(201);
  });

  it("POST /sell returns 400 for invalid JSON", async () => {
    const res = await app.request("/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("JSON");
  });

  it("POST /sell returns 400 when capability is missing", async () => {
    const res = await app.request("/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "TTS", unit: "char", priceUsd: 0.001 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sell returns 400 when model is not a string", async () => {
    const res = await app.request("/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.001, model: 123 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sell returns 400 when isActive is not a boolean", async () => {
    const res = await app.request("/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.001, isActive: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /sell returns 400 when sortOrder is not an integer", async () => {
    const res = await app.request("/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.001, sortOrder: 1.5 }),
    });
    expect(res.status).toBe(400);
  });

  // ── PUT /sell/:id ──

  it("PUT /sell/:id returns 404 when rate not found", async () => {
    const res = await app.request("/sell/nonexistent-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceUsd: 0.002 }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /sell/:id returns 400 for invalid JSON", async () => {
    const res = await app.request("/sell/some-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "bad{json",
    });
    expect(res.status).toBe(400);
  });

  // ── DELETE /sell/:id ──

  it("DELETE /sell/:id returns 404 when not found", async () => {
    const res = await app.request("/sell/nonexistent-id", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("DELETE /sell/:id returns 200 when found", async () => {
    // Create first
    const createRes = await app.request("/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", displayName: "TTS", unit: "char", priceUsd: 0.001 }),
    });
    const created = (await createRes.json()) as { id: string };

    const res = await app.request(`/sell/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  // ── POST /provider ──

  it("POST /provider creates a provider cost", async () => {
    const res = await app.request("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", adapter: "openai", unit: "char", costUsd: 0.0001 }),
    });
    expect(res.status).toBe(201);
  });

  it("POST /provider returns 400 for invalid JSON", async () => {
    const res = await app.request("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("JSON");
  });

  it("POST /provider returns 400 when model is not a string", async () => {
    const res = await app.request("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", adapter: "openai", unit: "char", costUsd: 0.001, model: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /provider returns 400 when priority is not an integer", async () => {
    const res = await app.request("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", adapter: "openai", unit: "char", costUsd: 0.001, priority: 1.5 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /provider returns 400 when latencyClass is not a string", async () => {
    const res = await app.request("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", adapter: "openai", unit: "char", costUsd: 0.001, latencyClass: 100 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /provider returns 400 when isActive is not a boolean", async () => {
    const res = await app.request("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", adapter: "openai", unit: "char", costUsd: 0.001, isActive: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  // ── PUT /provider/:id ──

  it("PUT /provider/:id returns 404 when not found", async () => {
    const res = await app.request("/provider/nonexistent-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ costUsd: 0.002 }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /provider/:id returns 400 for invalid JSON", async () => {
    const res = await app.request("/provider/some-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "bad{json",
    });
    expect(res.status).toBe(400);
  });

  // ── DELETE /provider/:id ──

  it("DELETE /provider/:id returns 404 when not found", async () => {
    const res = await app.request("/provider/nonexistent-id", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("DELETE /provider/:id returns 200 when found", async () => {
    const createRes = await app.request("/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "tts", adapter: "openai", unit: "char", costUsd: 0.0001 }),
    });
    const created = (await createRes.json()) as { id: string };

    const res = await app.request(`/provider/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  // ── GET /margins ──

  it("GET /margins returns margin report", async () => {
    const res = await app.request("/margins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { margins: unknown[] };
    expect(body).toHaveProperty("margins");
  });

  it("GET /margins filters by capability", async () => {
    const res = await app.request("/margins?capability=tts");
    expect(res.status).toBe(200);
  });
});
