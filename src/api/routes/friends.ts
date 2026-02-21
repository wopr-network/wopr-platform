import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant, validateTenantOwnership } from "../../auth/index.js";
import { logger } from "../../config/logger.js";
import { proxyToInstance } from "./friends-proxy.js";
import { autoAcceptRuleSchema, sendFriendRequestSchema, updateCapabilitiesSchema } from "./friends-types.js";

/** Allowlist: only alphanumeric, hyphens, and underscores. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const FLEET_DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";

const friendsTokenMetadataMap = buildTokenMetadataMap();

/** Helper to get instance tenantId from bot profile */
async function getInstanceTenantId(instanceId: string): Promise<string | undefined> {
  try {
    const { ProfileStore } = await import("../../fleet/profile-store.js");
    const store = new ProfileStore(FLEET_DATA_DIR);
    const profile = await store.get(instanceId);
    return profile?.tenantId;
  } catch {
    return undefined;
  }
}

// BOUNDARY(WOP-805): REST is the correct layer for friends management.
// These routes proxy to the bot instance's internal API. Bearer-token-scoped,
// not consumed by the dashboard UI's tRPC client.
export const friendsRoutes = new Hono();

// Friends management: read for viewing, write for mutations (enforced per-route)
if (friendsTokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured -- friends routes will reject all requests");
}
friendsRoutes.use("/*", scopedBearerAuthWithTenant(friendsTokenMetadataMap, "read"));

const friendsWriteAuth = scopedBearerAuthWithTenant(friendsTokenMetadataMap, "write");

/** GET / -- List all friends for a bot instance */
friendsRoutes.get("/", async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  // Validate tenant ownership
  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
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

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const result = await proxyToInstance(instanceId, "GET", "/p2p/discovered");
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** POST /requests -- Send a friend request */
friendsRoutes.post("/requests", friendsWriteAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
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

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const result = await proxyToInstance(instanceId, "GET", "/p2p/friends/requests");
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** POST /requests/:reqId/accept -- Accept a friend request */
friendsRoutes.post("/requests/:reqId/accept", friendsWriteAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const reqId = c.req.param("reqId");
  if (!SAFE_ID_RE.test(reqId)) {
    return c.json({ error: "Invalid request ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "POST", `/p2p/friends/requests/${reqId}/accept`);
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** POST /requests/:reqId/reject -- Reject a friend request */
friendsRoutes.post("/requests/:reqId/reject", friendsWriteAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const reqId = c.req.param("reqId");
  if (!SAFE_ID_RE.test(reqId)) {
    return c.json({ error: "Invalid request ID" }, 400);
  }

  const result = await proxyToInstance(instanceId, "POST", `/p2p/friends/requests/${reqId}/reject`);
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** PATCH /:friendId/capabilities -- Set friend capabilities */
friendsRoutes.patch("/:friendId/capabilities", friendsWriteAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
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

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const result = await proxyToInstance(instanceId, "GET", "/p2p/friends/auto-accept");
  return c.json(result.data ?? { error: result.error }, result.status as ContentfulStatusCode);
});

/** PUT /auto-accept -- Update auto-accept rules */
friendsRoutes.put("/auto-accept", friendsWriteAuth, async (c) => {
  const instanceId = c.req.param("id") as string;
  if (!SAFE_ID_RE.test(instanceId)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const tenantId = await getInstanceTenantId(instanceId);
  const ownershipError = validateTenantOwnership(c, instanceId, tenantId);
  if (ownershipError) {
    return ownershipError;
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
