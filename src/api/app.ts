import { Hono } from "hono";
import { fleetRoutes } from "./routes/fleet.js";
import { healthRoutes } from "./routes/health.js";

export const app = new Hono();

app.route("/health", healthRoutes);
app.route("/fleet", fleetRoutes);
