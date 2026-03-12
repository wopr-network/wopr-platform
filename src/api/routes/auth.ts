/**
 * Auth Routes — Mounts better-auth's HTTP handler as a Hono route.
 *
 * All requests to `/api/auth/*` are forwarded to better-auth, which handles:
 * - POST /api/auth/sign-up/email — Register with email + password
 * - POST /api/auth/sign-in/email — Sign in with email + password
 * - POST /api/auth/sign-out — Sign out (invalidate session)
 * - GET  /api/auth/get-session — Get current session
 *
 * better-auth manages its own session cookies and CSRF protection.
 */

import type { Auth } from "@wopr-network/platform-core/auth/better-auth";
import { Hono } from "hono";

/**
 * Create auth routes that delegate to better-auth's handler.
 *
 * @param auth - The better-auth instance (use `getAuth()`)
 */
export function createAuthRoutes(auth: Auth): Hono {
  const routes = new Hono();

  routes.all("/*", async (c) => {
    const response = await auth.handler(c.req.raw);
    return response;
  });

  return routes;
}
