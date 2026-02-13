import { Hono } from "hono";

export const fleetRoutes = new Hono();

// Placeholder — WOP-220 will implement Fleet Manager with Docker API integration
fleetRoutes.get("/", (c) => {
  return c.json({ bots: [] });
});
