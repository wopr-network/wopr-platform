import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { resolveSessionUser } from "../auth/index.js";
import { platformDefaultLimit, platformRateLimitRules, rateLimitByRoute } from "./middleware/rate-limit.js";
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

// Resolve better-auth session from core daemon cookie (non-blocking: sets
// c.set("user") when a valid session exists, otherwise falls through).
const coreDaemonUrl = process.env.CORE_DAEMON_URL || "http://localhost:3000";
app.use("/api/*", resolveSessionUser({ coreDaemonUrl }));
app.use("/fleet/*", resolveSessionUser({ coreDaemonUrl }));

app.route("/health", healthRoutes);
app.route("/fleet", fleetRoutes);
app.route("/api/quota", quotaRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api", secretsRoutes);
app.route("/api/instances/:id/snapshots", snapshotRoutes);
app.route("/api/instances/:id/friends", friendsRoutes);
