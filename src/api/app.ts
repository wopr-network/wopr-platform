import { Hono } from "hono";
import { fleetRoutes } from "./routes/fleet.js";
import { healthRoutes } from "./routes/health.js";
import { quotaRoutes } from "./routes/quota.js";

export const app = new Hono();

app.route("/health", healthRoutes);
app.route("/fleet", fleetRoutes);
app.route("/api/quota", quotaRoutes);
