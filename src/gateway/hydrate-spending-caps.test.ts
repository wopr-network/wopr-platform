/**
 * Tests for hydrateSpendingCaps middleware.
 */

import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { DrizzleSpendingLimitsRepository } from "../monetization/drizzle-spending-limits-repository.js";
import { createTestDb } from "../test/db.js";
import { hydrateSpendingCaps } from "./hydrate-spending-caps.js";
import type { SpendingCaps } from "./spending-cap.js";
import type { GatewayTenant } from "./types.js";

function makeTenant(id: string, spendingCaps?: SpendingCaps): GatewayTenant {
  return {
    id,
    spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
    spendingCaps,
  };
}

describe("hydrateSpendingCaps", () => {
  let db: DrizzleDb;
  let pool: PGlite;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterEach(async () => {
    await pool.close();
  });

  it("sets monthlyCapUsd from DB hardCap when tenant has no spendingCaps", async () => {
    const repo = new DrizzleSpendingLimitsRepository(db);
    await repo.upsert("t1", { global: { alertAt: null, hardCap: 100 }, perCapability: {} });

    const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
    app.use("/*", (c, next) => {
      c.set("gatewayTenant", makeTenant("t1"));
      return next();
    });
    app.use("/*", hydrateSpendingCaps(repo, { cacheTtlMs: 0 }));
    app.all("/*", (c) => {
      const tenant = c.get("gatewayTenant");
      return c.json({ caps: tenant.spendingCaps });
    });

    const resp = await app.request("/test", { method: "POST" });
    const body = (await resp.json()) as { caps: SpendingCaps };
    expect(body.caps.monthlyCapUsd).toBe(100);
    expect(body.caps.dailyCapUsd).toBeNull();
  });

  it("leaves spendingCaps undefined when DB has no hardCap (null)", async () => {
    const repo = new DrizzleSpendingLimitsRepository(db);
    // No upsert — DB returns default (hardCap: null)

    const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
    app.use("/*", (c, next) => {
      c.set("gatewayTenant", makeTenant("t2"));
      return next();
    });
    app.use("/*", hydrateSpendingCaps(repo, { cacheTtlMs: 0 }));
    app.all("/*", (c) => {
      const tenant = c.get("gatewayTenant");
      return c.json({ caps: tenant.spendingCaps ?? null });
    });

    const resp = await app.request("/test", { method: "POST" });
    const body = (await resp.json()) as { caps: null };
    expect(body.caps).toBeNull();
  });

  it("overrides existing spendingCaps with DB hardCap", async () => {
    const repo = new DrizzleSpendingLimitsRepository(db);
    await repo.upsert("t3", { global: { alertAt: null, hardCap: 200 }, perCapability: {} });

    const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
    app.use("/*", (c, next) => {
      c.set("gatewayTenant", makeTenant("t3", { dailyCapUsd: 50, monthlyCapUsd: 999 }));
      return next();
    });
    app.use("/*", hydrateSpendingCaps(repo, { cacheTtlMs: 0 }));
    app.all("/*", (c) => {
      const tenant = c.get("gatewayTenant");
      return c.json({ caps: tenant.spendingCaps });
    });

    const resp = await app.request("/test", { method: "POST" });
    const body = (await resp.json()) as { caps: SpendingCaps };
    expect(body.caps.monthlyCapUsd).toBe(200);
    expect(body.caps.dailyCapUsd).toBeNull();
  });

  it("passes through when no gatewayTenant on context", async () => {
    const repo = new DrizzleSpendingLimitsRepository(db);
    const app = new Hono();
    app.use("/*", hydrateSpendingCaps(repo, { cacheTtlMs: 0 }));
    app.all("/*", (c) => c.json({ ok: true }));

    const resp = await app.request("/test", { method: "POST" });
    expect(resp.status).toBe(200);
  });

  it("caches DB lookups within TTL", async () => {
    const repo = new DrizzleSpendingLimitsRepository(db);
    await repo.upsert("t4", { global: { alertAt: null, hardCap: 50 }, perCapability: {} });

    const getSpy = vi.spyOn(repo, "get");

    const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
    app.use("/*", (c, next) => {
      c.set("gatewayTenant", makeTenant("t4"));
      return next();
    });
    app.use("/*", hydrateSpendingCaps(repo, { cacheTtlMs: 60_000 }));
    app.all("/*", (c) => c.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      await app.request("/test", { method: "POST" });
    }

    expect(getSpy).toHaveBeenCalledTimes(1);
    getSpy.mockRestore();
  });
});
