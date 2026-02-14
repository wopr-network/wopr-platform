import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { resolveSessionUser } from "../auth/index.js";
import { platformDefaultLimit, platformRateLimitRules, rateLimitByRoute } from "./middleware/rate-limit.js";
import { adminAuditRoutes, auditRoutes } from "./routes/audit.js";
import { billingRoutes } from "./routes/billing.js";
import { fleetRoutes } from "./routes/fleet.js";
import { friendsRoutes } from "./routes/friends.js";
import { healthRoutes } from "./routes/health.js";
import { quotaRoutes } from "./routes/quota.js";
import { secretsRoutes } from "./routes/secrets.js";
import { snapshotRoutes } from "./routes/snapshots.js";

export const app = new Hono();

app.use(
  "/*",
  cors({
    origin: process.env.UI_ORIGIN || "http://localhost:3001",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/*", secureHeaders());
app.use("*", rateLimitByRoute(platformRateLimitRules, platformDefaultLimit));

// better-auth handler — serves /api/auth/* (signup, login, session, etc.)
// Lazily initialized to avoid opening DB at import time.
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const { getAuth } = await import("../auth/better-auth.js");
  return getAuth().handler(c.req.raw);
});

// Resolve session user from better-auth cookie on all API and fleet routes.
// This sets c.set("user") if a valid session cookie is present.
// Routes that also accept API tokens (scopedBearerAuth) will override if needed.
app.use("/api/*", resolveSessionUser());
app.use("/fleet/*", resolveSessionUser());

app.route("/health", healthRoutes);
app.route("/fleet", fleetRoutes);
app.route("/api/quota", quotaRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api", secretsRoutes);
app.route("/api/instances/:id/snapshots", snapshotRoutes);
app.route("/api/instances/:id/friends", friendsRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/admin/audit", adminAuditRoutes);
