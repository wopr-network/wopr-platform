import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEnv } from "../../audit/types.js";
import type { DrizzleDb } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { createAuditRoutes } from "./audit.js";

// Spy on the purge side effect (fire-and-forget in the handler)
const purgeForUserSpy = vi.fn().mockResolvedValue(0);
vi.mock("../../audit/retention.js", () => ({
  purgeExpiredEntriesForUser: (...args: unknown[]) => purgeForUserSpy(...args),
}));

describe("audit routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    purgeForUserSpy.mockClear();
  });

  /** Build a Hono app that optionally injects `user` into context, then mounts audit routes. */
  function buildApp(user?: { id: string; isAdmin?: boolean }) {
    const app = new Hono<AuditEnv>();
    app.use("/*", async (c, next) => {
      if (user) {
        c.set("user", user);
        c.set("authMethod", "session");
      }
      await next();
    });
    app.route("/", createAuditRoutes(db));
    return app;
  }

  /** Seed one audit entry directly into the database. */
  async function seedEntry(overrides: { userId: string; action?: string; timestamp?: number }) {
    const id = crypto.randomUUID();
    await db.insert(auditLog).values({
      id,
      timestamp: overrides.timestamp ?? Date.now(),
      userId: overrides.userId,
      authMethod: "session",
      action: overrides.action ?? "auth.login",
      resourceType: "user",
      resourceId: null,
      details: null,
      ipAddress: null,
      userAgent: null,
    });
    return id;
  }

  describe("GET /", () => {
    it("returns 401 when no user is set", async () => {
      const app = buildApp(); // no user
      const res = await app.request("/");

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("returns paginated audit entries for the authenticated user", async () => {
      const userId = crypto.randomUUID();
      const otherUserId = crypto.randomUUID();

      // Seed 3 entries for our user, 1 for another user
      await seedEntry({ userId, action: "auth.login", timestamp: 1000 });
      await seedEntry({ userId, action: "auth.logout", timestamp: 2000 });
      await seedEntry({ userId, action: "instance.create", timestamp: 3000 });
      await seedEntry({ userId: otherUserId, action: "auth.login", timestamp: 4000 });

      const app = buildApp({ id: userId });
      const res = await app.request("/?limit=2");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3); // only our user's entries counted
      expect(body.entries).toHaveLength(2); // limit=2
      // Ordered by timestamp DESC
      expect(body.entries[0].action).toBe("instance.create");
      expect(body.entries[1].action).toBe("auth.logout");
      // Verify other user's entries are excluded
      for (const entry of body.entries) {
        expect(entry.user_id).toBe(userId);
      }
    });

    it("triggers purgeExpiredEntriesForUser on every call", async () => {
      const userId = crypto.randomUUID();
      const app = buildApp({ id: userId });

      await app.request("/");

      expect(purgeForUserSpy).toHaveBeenCalledOnce();
      // Second arg is the userId
      expect(purgeForUserSpy.mock.calls[0][1]).toBe(userId);
    });
  });
});
