import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
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

app.route("/health", healthRoutes);
app.route("/fleet", fleetRoutes);
app.route("/api/quota", quotaRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api", secretsRoutes);
app.route("/api/instances/:id/snapshots", snapshotRoutes);
app.route("/api/instances/:id/friends", friendsRoutes);
