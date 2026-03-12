import type { AuthEnv } from "@wopr-network/platform-core/auth";
import type {
  ILoginHistoryRepository,
  LoginHistoryEntry,
} from "@wopr-network/platform-core/auth/login-history-repository";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { loginHistoryRoutes, setLoginHistoryRepo } from "./login-history.js";

function makeMockRepo(entries: LoginHistoryEntry[]): ILoginHistoryRepository {
  return {
    findByUserId: async (_userId: string, _limit?: number) => entries,
  };
}

describe("GET /api/auth/login-history", () => {
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    app = new Hono<AuthEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-1", roles: ["user"] });
      c.set("authMethod", "session");
      await next();
    });
    app.route("/api/auth/login-history", loginHistoryRoutes);
  });

  it("returns 401 when no user", async () => {
    const noAuthApp = new Hono<AuthEnv>();
    noAuthApp.route("/api/auth/login-history", loginHistoryRoutes);
    setLoginHistoryRepo(makeMockRepo([]));
    const res = await noAuthApp.request("/api/auth/login-history");
    expect(res.status).toBe(401);
  });

  it("returns login history entries", async () => {
    const entries: LoginHistoryEntry[] = [
      { ip: "1.2.3.4", userAgent: "Mozilla/5.0", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    setLoginHistoryRepo(makeMockRepo(entries));
    const res = await app.request("/api/auth/login-history");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(entries);
  });

  it("returns empty array when no sessions", async () => {
    setLoginHistoryRepo(makeMockRepo([]));
    const res = await app.request("/api/auth/login-history");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
