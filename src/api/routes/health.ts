import { Hono } from "hono";

export const healthRoutes = new Hono();

// Liveness — is the HTTP server running?
healthRoutes.get("/", (c) => {
  return c.json({ status: "ok", service: "wopr-platform" });
});

// Readiness — is the server ready to serve traffic?
// For now, if we can respond, we're ready.
// Future: check DB connection, gateway mount status.
healthRoutes.get("/ready", (c) => {
  return c.json({ status: "ready", service: "wopr-platform" });
});
