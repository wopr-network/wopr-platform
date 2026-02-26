import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { checkTenantStatus, createTenantStatusGate } from "./tenant-status-middleware.js";
import { TenantStatusStore } from "./tenant-status-store.js";

describe("createTenantStatusGate", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;
  let store: TenantStatusStore;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    store = new TenantStatusStore(db);
  });

  afterEach(() => {
    pool.close();
  });

  function createApp(tenantId: string | undefined) {
    const app = new Hono();
    const gate = createTenantStatusGate({
      statusStore: store,
      resolveTenantId: () => tenantId,
    });
    app.use("*", gate);
    app.get("/test", (c) => c.json({ ok: true }));
    return app;
  }

  it("allows active tenant through", async () => {
    await store.ensureExists("tenant-1");
    const app = createApp("tenant-1");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("allows unknown tenant through (defaults to active)", async () => {
    const app = createApp("unknown-tenant");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("allows grace_period tenant through", async () => {
    await store.setGracePeriod("tenant-1");
    const app = createApp("tenant-1");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("blocks suspended tenant with 403", async () => {
    await store.suspend("tenant-1", "testing", "admin-1");
    const app = createApp("tenant-1");
    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("account_suspended");
  });

  it("blocks banned tenant with 403", async () => {
    await store.ban("tenant-1", "tos violation", "admin-1");
    const app = createApp("tenant-1");
    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("account_banned");
  });

  it("passes through when no tenant ID resolved", async () => {
    const app = createApp(undefined);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});

describe("checkTenantStatus", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;
  let store: TenantStatusStore;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    store = new TenantStatusStore(db);
  });

  afterEach(() => {
    pool.close();
  });

  it("returns null for active tenant", async () => {
    await store.ensureExists("tenant-1");
    expect(await checkTenantStatus(store, "tenant-1")).toBeNull();
  });

  it("returns null for unknown tenant", async () => {
    expect(await checkTenantStatus(store, "unknown")).toBeNull();
  });

  it("returns null for grace_period tenant", async () => {
    await store.setGracePeriod("tenant-1");
    expect(await checkTenantStatus(store, "tenant-1")).toBeNull();
  });

  it("returns error for suspended tenant", async () => {
    await store.suspend("tenant-1", "reason", "admin-1");
    const result = await checkTenantStatus(store, "tenant-1");
    expect(result).not.toBeNull();
    expect(result?.error).toBe("account_suspended");
  });

  it("returns error for banned tenant", async () => {
    await store.ban("tenant-1", "reason", "admin-1");
    const result = await checkTenantStatus(store, "tenant-1");
    expect(result).not.toBeNull();
    expect(result?.error).toBe("account_banned");
  });
});
