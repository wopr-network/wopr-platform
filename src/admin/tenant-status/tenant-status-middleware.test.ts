import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import * as dbSchema from "../../db/schema/index.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import { DrizzleTenantStatusRepository } from "../../infrastructure/persistence/drizzle-tenant-status-repository.js";
import { createTestDb } from "../../test/db.js";
import { checkTenantStatus, createTenantStatusGate } from "./tenant-status-middleware.js";

describe("createTenantStatusGate", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let repo: DrizzleTenantStatusRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = drizzle(t.sqlite, { schema: dbSchema });
    sqlite = t.sqlite;
    repo = new DrizzleTenantStatusRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createApp(tenantId: string | undefined) {
    const app = new Hono();
    const gate = createTenantStatusGate({
      statusRepo: repo,
      resolveTenantId: () => tenantId,
    });
    app.use("*", gate);
    app.get("/test", (c) => c.json({ ok: true }));
    return app;
  }

  it("allows active tenant through", async () => {
    await repo.ensureExists(TenantId.create("tenant-1"));
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
    await repo.setGracePeriod(TenantId.create("tenant-1"));
    const app = createApp("tenant-1");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("blocks suspended tenant with 403", async () => {
    await repo.suspend(TenantId.create("tenant-1"), "testing", "admin-1");
    const app = createApp("tenant-1");
    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("account_suspended");
  });

  it("blocks banned tenant with 403", async () => {
    await repo.ban(TenantId.create("tenant-1"), "tos violation", "admin-1");
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
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let repo: DrizzleTenantStatusRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = drizzle(t.sqlite, { schema: dbSchema });
    sqlite = t.sqlite;
    repo = new DrizzleTenantStatusRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns null for active tenant", async () => {
    await repo.ensureExists(TenantId.create("tenant-1"));
    expect(await checkTenantStatus(repo, "tenant-1")).toBeNull();
  });

  it("returns null for unknown tenant", async () => {
    expect(await checkTenantStatus(repo, "unknown")).toBeNull();
  });

  it("returns null for grace_period tenant", async () => {
    await repo.setGracePeriod(TenantId.create("tenant-1"));
    expect(await checkTenantStatus(repo, "tenant-1")).toBeNull();
  });

  it("returns error for suspended tenant", async () => {
    await repo.suspend(TenantId.create("tenant-1"), "reason", "admin-1");
    const result = await checkTenantStatus(repo, "tenant-1");
    expect(result).not.toBeNull();
    expect(result?.error).toBe("account_suspended");
  });

  it("returns error for banned tenant", async () => {
    await repo.ban(TenantId.create("tenant-1"), "reason", "admin-1");
    const result = await checkTenantStatus(repo, "tenant-1");
    expect(result).not.toBeNull();
    expect(result?.error).toBe("account_banned");
  });
});
