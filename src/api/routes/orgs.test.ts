import type { PGlite } from "@electric-sql/pglite";
import { RoleStore } from "@wopr-network/platform-core/admin";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "@wopr-network/platform-core/test/db";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleOrgRepository } from "../../org/drizzle-org-repository.js";
import { createOrgRoutes } from "./orgs.js";

let sharedDb: DrizzleDb;
let sharedPool: PGlite;

beforeAll(async () => {
  ({ db: sharedDb, pool: sharedPool } = await createTestDb());
  await beginTestTransaction(sharedPool);
});

afterAll(async () => {
  await endTestTransaction(sharedPool);
  await sharedPool.close();
});

function buildApp(db: DrizzleDb): { app: Hono<AuthEnv>; roleStore: RoleStore } {
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

  return { app, roleStore };
}

describe("POST /api/orgs", () => {
  let app: Hono<AuthEnv>;
  let roleStore: RoleStore;

  beforeEach(async () => {
    await rollbackTestTransaction(sharedPool);
    ({ app, roleStore } = buildApp(sharedDb));
  });

  it("creates an org and assigns tenant_admin role", async () => {
    const res = await app.request("/api/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Org", slug: "my-org" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.slug).toBe("my-org");

    // Verify role was assigned
    const role = await roleStore.getRole("user-1", body.id);
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

  beforeEach(async () => {
    await rollbackTestTransaction(sharedPool);
    ({ app } = buildApp(sharedDb));
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
    const orgRepo = new DrizzleOrgRepository(sharedDb);
    const roleStore = new RoleStore(sharedDb);
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
  });
});
