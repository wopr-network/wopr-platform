import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression test: verify that in app.ts, the login-history route is mounted
 * BEFORE the better-auth catch-all wildcard (WOP-1974).
 *
 * Hono matches routes in registration order. If the better-auth /api/auth/*
 * catch-all appears first, it swallows GET /api/auth/login-history.
 */
describe("route ordering in app.ts (WOP-1974)", () => {
  it("mounts /api/auth/login-history before the better-auth /api/auth/* catch-all", () => {
    const appPath = resolve(__dirname, "../app.ts");
    const src = readFileSync(appPath, "utf-8");

    const loginHistoryIdx = src.indexOf('app.route("/api/auth/login-history"');
    const betterAuthIdx = src.indexOf('app.on(["POST", "GET"], "/api/auth/*"');

    expect(loginHistoryIdx).toBeGreaterThan(-1);
    expect(betterAuthIdx).toBeGreaterThan(-1);
    expect(loginHistoryIdx).toBeLessThan(betterAuthIdx);
  });
});
