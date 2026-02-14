import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "../auth/index.js";
import { requireEmailVerified } from "./require-verified.js";
import { initVerificationSchema } from "./verification.js";

describe("requireEmailVerified middleware", () => {
  let db: Database.Database;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT
      )
    `);
    initVerificationSchema(db);
    db.prepare("INSERT INTO user (id, email, name) VALUES (?, ?, ?)").run("user-1", "alice@test.com", "Alice");

    const middleware = requireEmailVerified(() => db);

    app = new Hono<AuthEnv>();
    // Simulate session auth middleware setting user context
    app.use("/test/*", async (c, next) => {
      const authMethod = (c.req.header("X-Auth-Method") || "session") as "session" | "api_key";
      const userId = c.req.header("X-User-Id") || "user-1";
      c.set("authMethod", authMethod);
      c.set("user", { id: userId, roles: ["user"] });
      return next();
    });
    app.use("/test/*", middleware);
    app.post("/test/create", (c) => c.json({ ok: true }));

    // Route without auth context — use a plain Hono app for this
    const noauthApp = new Hono();
    noauthApp.use("/noauth/*", middleware);
    noauthApp.post("/noauth/create", (c) => c.json({ ok: true }));
    // Mount the noauth app into the main app
    app.route("/", noauthApp);
  });

  afterEach(() => {
    db.close();
  });

  it("should block session-authenticated users without verified email", async () => {
    const res = await app.request("/test/create", {
      method: "POST",
      headers: { "X-Auth-Method": "session", "X-User-Id": "user-1" },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("should allow session-authenticated users with verified email", async () => {
    db.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").run("user-1");

    const res = await app.request("/test/create", {
      method: "POST",
      headers: { "X-Auth-Method": "session", "X-User-Id": "user-1" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("should always allow API token auth", async () => {
    const res = await app.request("/test/create", {
      method: "POST",
      headers: { "X-Auth-Method": "api_key", "X-User-Id": "token:write" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("should pass through when no auth context is set", async () => {
    const res = await app.request("/noauth/create", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
