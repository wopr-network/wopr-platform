import { Hono } from "hono";
import { billingRoutes } from "./routes/billing.js";
import { fleetRoutes } from "./routes/fleet.js";
import { healthRoutes } from "./routes/health.js";
import { quotaRoutes } from "./routes/quota.js";
import { secretsRoutes } from "./routes/secrets.js";
import { snapshotRoutes } from "./routes/snapshots.js";

export const app = new Hono();

app.route("/health", healthRoutes);
app.route("/fleet", fleetRoutes);
app.route("/api/quota", quotaRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api", secretsRoutes);
app.route("/api/instances/:id/snapshots", snapshotRoutes);
