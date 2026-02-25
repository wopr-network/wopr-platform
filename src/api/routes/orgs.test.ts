import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoleStore } from "../../admin/roles/role-store.js";
import type { AuthEnv } from "../../auth/index.js";
import { DrizzleOrgRepository } from "../../org/drizzle-org-repository.js";
import { createTestDb } from "../../test/db.js";
import { createOrgRoutes } from "./orgs.js";

function setup() {
  const { db, sqlite } = createTestDb();
  const orgRepo = new DrizzleOrgRepository(db);
  const roleStore = new RoleStore(db);
  const routes = createOrgRoutes({ orgRepo, roleStore });

  // Wrap with a test app that sets a fake authenticated user
  const app = new Hono<AuthEnv>();
  // Default: authenticated as user-1
  app.use("*", async (c, next) => {
    c.set("user", { id: "user-1", roles: ["user"] });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/api/orgs", routes);

  return { app, db, orgRepo, roleStore, close: () => sqlite.close() };
}

describe("POST /api/orgs", () => {
  let app: Hono<AuthEnv>;
  let close: () => void;
  let roleStore: RoleStore;

  beforeEach(() => {
    const t = setup();
    app = t.app;
    close = t.close;
    roleStore = t.roleStore;
  });

  afterEach(() => {
    close();
  });

  it("creates an org and assigns tenant_admin role", async () => {
    const res = await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Org", slug: "my-org" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.slug).toBe("my-org");

    // Verify role was assigned
    const role = roleStore.getRole("user-1", body.id);
    expect(role).toBe("tenant_admin");
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate slug", async () => {
    await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Org A", slug: "same-slug" }),
    });
    const res = await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Org B", slug: "same-slug" }),
    });
    expect(res.status).toBe(409);
  });

  it("auto-generates slug when not provided", async () => {
    const res = await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cool Org Name" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe("cool-org-name");
  });
});

describe("GET /api/orgs", () => {
  let app: Hono<AuthEnv>;
  let close: () => void;

  beforeEach(() => {
    const t = setup();
    app = t.app;
    close = t.close;
  });

  afterEach(() => {
    close();
  });

  it("returns orgs the user owns", async () => {
    // Create two orgs
    await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Org A", slug: "org-a" }),
    });
    await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Org B", slug: "org-b" }),
    });

    const res = await app.request("/api/orgs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs).toHaveLength(2);
  });

  it("returns empty array when user has no orgs", async () => {
    const res = await app.request("/api/orgs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgs).toHaveLength(0);
  });
});

describe("unauthenticated access", () => {
  it("returns 401 when no user is set", async () => {
    const { db, sqlite } = createTestDb();
    const orgRepo = new DrizzleOrgRepository(db);
    const roleStore = new RoleStore(db);
    const routes = createOrgRoutes({ orgRepo, roleStore });

    const app = new Hono();
    // No auth middleware — user is not set
    app.route("/api/orgs", routes);

    const res = await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Org" }),
    });
    expect(res.status).toBe(401);
    sqlite.close();
  });
});
