import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../../config/logger.js";
import { proxyToInstance } from "./friends-proxy.js";
import { autoAcceptRuleSchema, sendFriendRequestSchema, updateCapabilitiesSchema } from "./friends-types.js";

const FLEET_API_TOKEN = process.env.FLEET_API_TOKEN;

/** Allowlist: only alphanumeric, hyphens, and underscores. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const friendsRoutes = new Hono();

// Require bearer token for all friends endpoints
if (!FLEET_API_TOKEN) {
  logger.warn("FLEET_API_TOKEN is not set -- friends routes will reject all requests");
}
friendsRoutes.use("/*", bearerAuth({ token: FLEET_API_TOKEN || "" }));

/** GET / -- List all friends for a bot instance */
friendsRoutes.get("/", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "GET", "/p2p/friends");
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** GET /discovered -- List discovered bots on the network */
friendsRoutes.get("/discovered", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "GET", "/p2p/discovered");
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** POST /requests -- Send a friend request */
friendsRoutes.post("/requests", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = sendFriendRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const result = await proxyToInstance(instanceId, "POST", "/p2p/friends/requests", parsed.data);
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** GET /requests -- List pending friend requests */
friendsRoutes.get("/requests", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "GET", "/p2p/friends/requests");
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** POST /requests/:reqId/accept -- Accept a friend request */
friendsRoutes.post("/requests/:reqId/accept", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const reqId = c.req.param("reqId");
  if (!SAFE_ID_RE.test(reqId)) {
    return c.json({ error: "Invalid request ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "POST", `/p2p/friends/requests/${reqId}/accept`);
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** POST /requests/:reqId/reject -- Reject a friend request */
friendsRoutes.post("/requests/:reqId/reject", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const reqId = c.req.param("reqId");
  if (!SAFE_ID_RE.test(reqId)) {
    return c.json({ error: "Invalid request ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "POST", `/p2p/friends/requests/${reqId}/reject`);
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** PATCH /:friendId/capabilities -- Set friend capabilities */
friendsRoutes.patch("/:friendId/capabilities", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const friendId = c.req.param("friendId");
  if (!SAFE_ID_RE.test(friendId)) {
    return c.json({ error: "Invalid friend ID" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = updateCapabilitiesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const result = await proxyToInstance(instanceId, "PATCH", `/p2p/friends/${friendId}/capabilities`, parsed.data);
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** GET /auto-accept -- Get auto-accept rules */
friendsRoutes.get("/auto-accept", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "GET", "/p2p/friends/auto-accept");
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** PUT /auto-accept -- Update auto-accept rules */
friendsRoutes.put("/auto-accept", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = autoAcceptRuleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  const result = await proxyToInstance(instanceId, "PUT", "/p2p/friends/auto-accept", parsed.data);
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});
