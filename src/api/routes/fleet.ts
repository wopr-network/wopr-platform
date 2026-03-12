import {
  buildTokenMetadataMap,
  scopedBearerAuthWithTenant,
  validateTenantOwnership,
} from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import { Credit } from "@wopr-network/platform-core/credits";
import { type IEmailVerifier, requireEmailVerified } from "@wopr-network/platform-core/email";
import { CAPABILITY_ENV_MAP } from "@wopr-network/platform-core/fleet/capability-env-map";
import { FleetEventEmitter } from "@wopr-network/platform-core/fleet/fleet-event-emitter";
import { BotNotFoundError, FleetManager } from "@wopr-network/platform-core/fleet/fleet-manager";
import { ImagePoller } from "@wopr-network/platform-core/fleet/image-poller";
import { findPlacement } from "@wopr-network/platform-core/fleet/placement";
import { defaultTemplatesDir, loadProfileTemplates } from "@wopr-network/platform-core/fleet/profile-loader";
import type { ProfileTemplate } from "@wopr-network/platform-core/fleet/profile-schema";
import { ProfileStore } from "@wopr-network/platform-core/fleet/profile-store";
import {
  getBotInstanceRepo,
  getCommandBus,
  getNodeRepo,
  getRecoveryOrchestrator,
} from "@wopr-network/platform-core/fleet/services";
import { createBotSchema, updateBotSchema } from "@wopr-network/platform-core/fleet/types";
import { ContainerUpdater } from "@wopr-network/platform-core/fleet/updater";
import type { IBotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import {
  checkInstanceQuota,
  DEFAULT_INSTANCE_LIMITS,
} from "@wopr-network/platform-core/monetization/quotas/quota-check";
import { buildResourceLimits } from "@wopr-network/platform-core/monetization/quotas/resource-limits";
import { NetworkPolicy } from "@wopr-network/platform-core/network/network-policy";
import { getProxyManager } from "@wopr-network/platform-core/proxy/singleton";
import { assertSafeRedirectUrl } from "@wopr-network/platform-core/security";
import Docker from "dockerode";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "../../config/index.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";

const docker = new Docker();
const store = new ProfileStore(DATA_DIR);
const networkPolicy = new NetworkPolicy(docker);

// Lazy singletons — defer DB-accessing service calls until first request so
// that importing this module in tests (without DATABASE_URL) does not crash.
let _fleet: FleetManager | null = null;
let _imagePoller: ImagePoller | null = null;
let _updater: ContainerUpdater | null = null;
let _fleetEventEmitter: FleetEventEmitter | null = null;

export function getFleetEventEmitter(): FleetEventEmitter {
  if (!_fleetEventEmitter) {
    _fleetEventEmitter = new FleetEventEmitter();
  }
  return _fleetEventEmitter;
}

function getFleet(): FleetManager {
  if (!_fleet) {
    // Only resolve DB-backed services when DATABASE_URL is available.
    // In test environments that mock FleetManager, DATABASE_URL is absent and
    // commandBus/instanceRepo are not needed (FleetManager gracefully handles
    // undefined by skipping remote-node operations).
    const commandBus = process.env.DATABASE_URL ? getCommandBus() : undefined;
    const instanceRepo = process.env.DATABASE_URL ? getBotInstanceRepo() : undefined;
    _fleet = new FleetManager(
      docker,
      store,
      config.discovery,
      networkPolicy,
      getProxyManager(),
      commandBus,
      instanceRepo,
      undefined,
      getFleetEventEmitter(),
    );
  }
  return _fleet;
}

function getImagePoller(): ImagePoller {
  if (!_imagePoller) {
    _imagePoller = new ImagePoller(docker, store);
  }
  return _imagePoller;
}

function getUpdater(): ContainerUpdater {
  if (!_updater) {
    _updater = new ContainerUpdater(docker, store, getFleet(), getImagePoller());
  }
  return _updater;
}

// Proxy so callers can use `fleet.x` without changing call sites, while
// deferring FleetManager construction until the first property access.
const fleet = new Proxy({} as FleetManager, {
  get(_target, prop) {
    return (getFleet() as unknown as Record<string | symbol, unknown>)[prop];
  },
  set(_target, prop, value) {
    (getFleet() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});
const imagePoller = new Proxy({} as ImagePoller, {
  get(_target, prop) {
    return (getImagePoller() as unknown as Record<string | symbol, unknown>)[prop];
  },
  set(_target, prop, value) {
    (getImagePoller() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});
const updater = new Proxy({} as ContainerUpdater, {
  get(_target, prop) {
    return (getUpdater() as unknown as Record<string | symbol, unknown>)[prop];
  },
  set(_target, prop, value) {
    (getUpdater() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});

// ---------------------------------------------------------------------------
// Injected billing deps — set via setFleetDeps() before the server starts.
// ---------------------------------------------------------------------------

export interface FleetRouteDeps {
  creditLedger: ICreditLedger;
  botBilling: IBotBilling;
  emailVerifier: IEmailVerifier;
}

let _deps: FleetRouteDeps | null = null;

export function setFleetDeps(deps: FleetRouteDeps): void {
  _deps = deps;
}

function getDeps(): FleetRouteDeps {
  if (!_deps) {
    throw new Error("Fleet route deps not initialized — call setFleetDeps() before serving requests");
  }
  return _deps;
}

// Wire up the poller to trigger updates via the updater
imagePoller.onUpdateAvailable = async (botId: string) => {
  try {
    const result = await updater.updateBot(botId);
    if (result.success) {
      logger.info(`Auto-updated bot ${botId}`);
    } else {
      logger.warn(`Auto-update failed for bot ${botId}: ${result.error}`);
    }
  } catch (err) {
    logger.error(`Auto-update error for bot ${botId}`, { err });
  }
};

/** UUID v4 format (lowercase hex with dashes). */
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Parse Docker log output into structured LogEntry objects. */
function parseLogLines(
  raw: string,
): { id: string; timestamp: string; level: string; source: string; message: string }[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, i) => {
      // Try structured format: "2026-01-01T00:00:00Z [LEVEL] message"
      const match = line.match(/^(\S+)\s+\[(\w+)]\s+(.*)$/);
      if (match) {
        const level = match[2].toLowerCase();
        return {
          id: `log-${i}`,
          timestamp: match[1],
          level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
          source: "container",
          message: match[3],
        };
      }
      // Try Docker timestamp prefix: "2026-01-01T00:00:00.000Z some message"
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/);
      if (tsMatch) {
        return {
          id: `log-${i}`,
          timestamp: tsMatch[1],
          level: "info",
          source: "container",
          message: tsMatch[2],
        };
      }
      // Plain line
      return {
        id: `log-${i}`,
        timestamp: new Date().toISOString(),
        level: "info",
        source: "container",
        message: line,
      };
    });
}

// BOUNDARY(WOP-805): REST fleet routes have a tRPC mirror at src/trpc/routers/fleet.ts.
// The tRPC fleet router covers: listInstances, getInstance, createInstance,
// controlInstance, getInstanceHealth, getInstanceLogs, getInstanceMetrics, listTemplates,
// getImageStatus (WOP-2104), triggerImageUpdate (WOP-2104), seed (WOP-2104).
//
// REST fleet routes have additional functionality NOT in tRPC:
//   - PATCH /fleet/bots/:id (update) — tRPC fleet router does NOT have update
//   - DELETE /fleet/bots/:id (remove) — tRPC fleet router does NOT have remove
//   - Proxy registration side effects are now centralized in FleetManager (WOP-917)
//
// Keep REST fleet routes for:
//   1. CLI/SDK consumers that use bearer token auth (not session cookies)
//   2. The additional operations not yet in tRPC (update, remove)
export const fleetRoutes = new Hono();

// Build scoped token metadata map from environment
const tokenMetadataMap = buildTokenMetadataMap();
if (tokenMetadataMap.size === 0) {
  logger.warn("No API tokens configured — fleet routes will reject all requests");
}

// Read-scoped auth for GET endpoints
const readAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "read");
// Write-scoped auth for mutating endpoints
const writeAuth = scopedBearerAuthWithTenant(tokenMetadataMap, "write");

/** Validate :id param as UUID on all /bots/:id routes. */
fleetRoutes.use("/bots/:id/*", async (c, next) => {
  const id = c.req.param("id") as string;
  if (!UUID_RE.test(id)) {
    return c.json({ error: "Invalid bot ID" }, 400);
  }
  return next();
});
fleetRoutes.use("/bots/:id", async (c, next) => {
  const id = c.req.param("id") as string;
  if (!UUID_RE.test(id)) {
    return c.json({ error: "Invalid bot ID" }, 400);
  }
  return next();
});

/** GET /fleet/bots — List bots for the authenticated tenant */
fleetRoutes.get("/bots", readAuth, async (c) => {
  const tokenTenantId = c.get("tokenTenantId");
  const isOperatorToken = c.get("isOperatorToken");

  let bots: Awaited<ReturnType<typeof fleet.listAll>>;
  if (tokenTenantId) {
    bots = await fleet.listByTenant(tokenTenantId);
  } else if (isOperatorToken) {
    bots = await fleet.listAll();
  } else {
    // Token has no tenant scope and is not an operator — reject.
    return c.json({ error: "Tenant scope required" }, 403);
  }
  return c.json({ bots });
});

/** POST /fleet/bots — Create a new bot from profile config */
fleetRoutes.post(
  "/bots",
  writeAuth,
  (c, next) => requireEmailVerified(getDeps().emailVerifier)(c, next),
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = createBotSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    // Validate tenant ID matches the authenticated token (for tenant-scoped tokens)
    const tokenTenantId = c.get("tokenTenantId");
    if (tokenTenantId && parsed.data.tenantId !== tokenTenantId) {
      return c.json({ error: "Cannot create bot for a different tenant" }, 403);
    }

    // Check credit balance before creating container (skip if billing DB unavailable)
    try {
      const tenantId = parsed.data.tenantId;

      // Payment gate (WOP-380): require minimum 17 cents (1 day of bot runtime)
      const balance = await getDeps().creditLedger.balance(tenantId);
      if (balance.lessThan(Credit.fromCents(17))) {
        return c.json(
          {
            error: "insufficient_credits",
            balance: balance.toCentsRounded(),
            required: 17,
            buyUrl: "/dashboard/credits",
          },
          402,
        );
      }

      // Count active instances for this tenant
      const allProfiles = await fleet.profiles.list();
      const activeInstances = allProfiles.filter((p) => p.tenantId === tenantId).length;

      // Check instance quota (unlimited by default for credit users)
      const quotaResult = checkInstanceQuota(DEFAULT_INSTANCE_LIMITS, activeInstances);
      if (!quotaResult.allowed) {
        return c.json(
          {
            error: quotaResult.reason || "Instance quota exceeded",
            currentInstances: quotaResult.currentInstances,
            maxInstances: quotaResult.maxInstances,
          },
          403,
        );
      }
    } catch (quotaErr) {
      // Billing DB not available (e.g., in tests) — skip quota enforcement
      logger.warn("Quota check skipped: billing DB unavailable", { err: quotaErr });
    }

    // Build default resource limits for bot container
    const resourceLimits = buildResourceLimits();

    // Placement: find best node for this bot
    let nodeId: string | undefined;
    try {
      const nodeRepo = getNodeRepo();
      const activeNodes = await nodeRepo.list(["active"]);
      const requiredMb = resourceLimits?.Memory ? Math.ceil(resourceLimits.Memory / (1024 * 1024)) : 100;
      const placement = findPlacement(activeNodes, requiredMb);
      if (!placement) {
        return c.json({ error: "no_capacity", message: "No node has sufficient capacity" }, 503);
      }
      nodeId = placement.nodeId;
      logger.info("Placement selected", {
        nodeId: placement.nodeId,
        host: placement.host,
        availableMb: placement.availableMb,
      });
    } catch (placementErr) {
      const msg = placementErr instanceof Error ? placementErr.message : String(placementErr);
      if (msg.includes("DATABASE_URL")) {
        // Node repo not configured (single-node dev mode) — skip placement
        logger.warn("Placement skipped: node repo unavailable (no DATABASE_URL)");
      } else {
        // Unexpected error (DB connection failure, network error, etc.) — propagate
        logger.error("Placement failed with unexpected error", { err: placementErr });
        throw placementErr;
      }
    }

    try {
      const profile = await fleet.create({ ...parsed.data, nodeId }, resourceLimits);

      // Register bot in billing system for lifecycle tracking
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("registerBot timeout")), 5000);
        });
        try {
          await Promise.race([
            getDeps().botBilling.registerBot(profile.id, parsed.data.tenantId, parsed.data.name),
            timeout,
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch (regErr) {
        logger.warn("Bot billing registration failed (non-fatal)", {
          botId: profile.id,
          tenantId: parsed.data.tenantId,
          botName: parsed.data.name,
          err: regErr,
        });
      }

      return c.json(profile, 201);
    } catch (err) {
      logger.error("Failed to create bot", { err });
      return c.json({ error: "Failed to create bot" }, 500);
    }
  },
);

/** GET /fleet/bots/:id — Get bot details + health */
fleetRoutes.get("/bots/:id", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  try {
    // Get bot profile to check tenant ownership
    const profile = await fleet.profiles.get(botId);

    // Validate tenant ownership
    const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
    if (ownershipError) {
      return ownershipError;
    }

    const status = await fleet.status(botId);
    return c.json(status);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** PATCH /fleet/bots/:id — Update bot config (triggers restart if running) */
fleetRoutes.patch("/bots/:id", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;

  // Check tenant ownership before allowing update
  const existingProfile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, existingProfile, existingProfile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateBotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Reject empty updates
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  try {
    const profile = await fleet.update(botId, parsed.data);
    return c.json(profile);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** DELETE /fleet/bots/:id — Stop and remove bot */
fleetRoutes.delete("/bots/:id", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;

  // Check tenant ownership before allowing deletion
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    await fleet.remove(botId, c.req.query("removeVolumes") === "true");

    // Capacity freed -- check if any waiting recovery tenants can now be placed
    Promise.resolve()
      .then(async () => {
        const repo = getRecoveryOrchestrator();
        if (!repo) return;
        const events = await repo.listEvents();
        for (const e of events) {
          try {
            await repo.retryWaiting(e.id);
          } catch (err) {
            logger.error("Auto-retry after bot removal failed for event", { eventId: e.id, err });
          }
        }
      })
      .catch((err) => {
        logger.error("Auto-retry after bot removal failed", { err });
      });

    return c.body(null, 204);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/start — Start a stopped bot */
fleetRoutes.post("/bots/:id/start", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  // Payment gate (WOP-380): require minimum 17 cents to start a bot
  try {
    const tenantId = profile?.tenantId;
    if (!tenantId) return c.json({ error: "Missing tenant" }, 400);
    const balance = await getDeps().creditLedger.balance(tenantId);
    if (balance.lessThan(Credit.fromCents(17))) {
      return c.json(
        {
          error: "insufficient_credits",
          balance: Math.round(balance.toCents()),
          required: 17,
          buyUrl: "/dashboard/credits",
        },
        402,
      );
    }
  } catch (err) {
    logger.warn("Credit check skipped on bot start: billing DB unavailable", { err });
  }

  try {
    await fleet.start(botId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/stop — Stop a running bot */
fleetRoutes.post("/bots/:id/stop", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    await fleet.stop(botId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/restart — Restart a running bot */
fleetRoutes.post("/bots/:id/restart", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    await fleet.restart(botId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/health — Per-bot health (state, uptime, CPU, memory) */
fleetRoutes.get("/bots/:id/health", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    const status = await fleet.status(botId);
    return c.json({
      id: status.id,
      state: status.state,
      health: status.health,
      uptime: status.uptime,
      stats: status.stats,
    });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/metrics — Per-bot resource metrics (CPU, memory) */
fleetRoutes.get("/bots/:id/metrics", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    const status = await fleet.status(botId);
    return c.json({
      id: status.id,
      stats: status.stats,
    });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/logs — Tail bot container logs (returns structured JSON) */
fleetRoutes.get("/bots/:id/logs", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const raw = c.req.query("tail");
  const parsed = raw != null ? Number.parseInt(raw, 10) : 100;
  const tail = Number.isNaN(parsed) || parsed < 1 ? 100 : Math.min(parsed, 10_000);
  try {
    const logs = await fleet.logs(botId, tail);
    return c.json(parseLogLines(logs));
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/logs/stream — SSE real-time log tailing */
fleetRoutes.get("/bots/:id/logs/stream", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  const rawTail = c.req.query("tail");
  const parsedTail = rawTail != null ? Number.parseInt(rawTail, 10) : 100;
  const tail = Number.isNaN(parsedTail) || parsedTail < 1 ? 100 : Math.min(parsedTail, 10_000);
  const since = c.req.query("since");

  let nodeStream: NodeJS.ReadableStream;
  try {
    const opts: { since?: string; tail: number } = { tail };
    if (since) opts.since = since;
    nodeStream = await fleet.logStream(botId, opts);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: (err as Error).message }, 404);
    throw err;
  }

  const { readable, writable } = new TransformStream<string, string>();
  const writer = writable.getWriter();

  let lineIndex = 0;
  let buffer = "";

  const cleanup = () => {
    nodeStream.removeListener("data", onData);
    nodeStream.removeListener("end", onEnd);
    nodeStream.removeListener("error", onError);
    const destroyable = nodeStream as unknown as { destroy?: () => void };
    if (typeof destroyable.destroy === "function") {
      destroyable.destroy();
    }
    writer.close().catch(() => {});
  };

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      const parsed = parseLogLines(line);
      if (parsed.length > 0) {
        const entry = { ...parsed[0], id: `log-${lineIndex++}` };
        writer.write(`data: ${JSON.stringify(entry)}\n\n`).catch(() => {
          cleanup();
        });
      }
    }
  };

  const onEnd = () => {
    if (buffer.length > 0) {
      const parsed = parseLogLines(buffer);
      if (parsed.length > 0) {
        const entry = { ...parsed[0], id: `log-${lineIndex++}` };
        writer.write(`data: ${JSON.stringify(entry)}\n\n`).catch(() => {});
      }
    }
    writer
      .write(`data: ${JSON.stringify({ type: "closed", reason: "container_stopped" })}\n\n`)
      .then(() => writer.close())
      .catch(() => {});
  };

  const onError = (err: Error) => {
    logger.error("Log stream error", { botId, err });
    writer
      .write(`data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`)
      .then(() => cleanup())
      .catch(() => cleanup());
  };

  nodeStream.on("data", onData);
  nodeStream.on("end", onEnd);
  nodeStream.on("error", onError);

  const signal = c.req.raw.signal;
  if (signal) {
    signal.addEventListener("abort", () => {
      cleanup();
    });
  }

  const encoder = new TextEncoder();
  const encodedStream = readable.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(chunk));
      },
    }),
  );

  return new Response(encodedStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

/** POST /fleet/bots/:id/update — Force update to latest image */
fleetRoutes.post("/bots/:id/update", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  try {
    const result = await updater.updateBot(botId);
    if (result.success) {
      return c.json(result);
    }
    return c.json(result, result.error === "Bot not found" ? 404 : 500);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/image-status — Current vs available digest + last check time */
fleetRoutes.get("/bots/:id/image-status", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) {
    return ownershipError;
  }

  // If we reach here, profile cannot be null (validated above)
  if (!profile) {
    return c.json({ error: "Bot not found" }, 404);
  }

  try {
    const status = imagePoller.getImageStatus(botId, profile);
    return c.json(status);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Seed bots from profile templates.
 * @param templates - Parsed profile templates to seed from.
 * @param existingNames - Set of bot names that already exist (mutated in place).
 */
export function seedBots(templates: ProfileTemplate[], existingNames: Set<string>): SeedResult {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const template of templates) {
    if (existingNames.has(template.name)) {
      skipped.push(template.name);
    } else {
      existingNames.add(template.name);
      created.push(template.name);
    }
  }

  return { created, skipped };
}

fleetRoutes.post("/seed", writeAuth, async (c) => {
  const templatesDir = defaultTemplatesDir();

  let templates: ProfileTemplate[];
  try {
    templates = loadProfileTemplates(templatesDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load templates";
    return c.json({ error: message }, 500);
  }

  if (templates.length === 0) {
    return c.json({ error: "No templates found" }, 404);
  }

  const profiles = await fleet.profiles.list();
  const existingNames = new Set(profiles.map((p) => p.name));
  const result = seedBots(templates, existingNames);
  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// Capability / identity helpers (shared between REST routes below)
// ---------------------------------------------------------------------------

/** GET /fleet/bots/:id/settings — Full bot settings (identity + capabilities + plugins + status) */
fleetRoutes.get("/bots/:id/settings", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  // Get live status
  let botState: "running" | "stopped" | "archived" = "stopped";
  try {
    const status = await fleet.status(botId);
    botState = status.state === "running" ? "running" : "stopped";
  } catch (err) {
    if (!(err instanceof BotNotFoundError)) throw err;
  }

  const pluginIds = (profile.env.WOPR_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const disabledSet = new Set(
    (profile.env.WOPR_PLUGINS_DISABLED || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const hostedKeys = new Set(
    (profile.env.WOPR_HOSTED_KEYS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const activeSuperpowers: Array<Record<string, unknown>> = [];
  const activeCapabilityIds = new Set<string>();

  for (const [capId, entry] of Object.entries(CAPABILITY_ENV_MAP)) {
    if (profile.env[entry.envKey]) {
      activeCapabilityIds.add(capId);
      activeSuperpowers.push({
        id: capId,
        name: capId,
        icon: "zap",
        mode: hostedKeys.has(entry.envKey) ? "hosted" : "byok",
        provider: entry.vaultProvider,
        model: "",
        usageCount: 0,
        usageLabel: "0 calls",
        spend: 0,
      });
    }
  }

  return c.json({
    id: profile.id,
    identity: { name: profile.name, avatar: "", personality: "" },
    brain: {
      provider: profile.env.WOPR_LLM_PROVIDER || "none",
      model: profile.env.WOPR_LLM_MODEL || "none",
      mode: hostedKeys.has("OPENROUTER_API_KEY") ? "hosted" : "byok",
      costPerMessage: "~$0.001",
      description: "",
    },
    channels: [],
    availableChannels: [],
    activeSuperpowers,
    availableSuperpowers: Object.keys(CAPABILITY_ENV_MAP)
      .filter((id) => !activeCapabilityIds.has(id))
      .map((id) => ({
        id,
        name: id,
        icon: "zap",
        description: `Add ${id} capability to your bot`,
        pricing: "Usage-based",
      })),
    installedPlugins: pluginIds.map((id) => ({
      id,
      name: id,
      description: "",
      icon: "",
      status: disabledSet.has(id) ? "disabled" : "active",
      capabilities: [],
    })),
    discoverPlugins: [],
    usage: { totalSpend: 0, creditBalance: 0, capabilities: [], trend: [] },
    status: botState,
  });
});

/** PUT /fleet/bots/:id/identity — Update bot name/avatar/personality */
fleetRoutes.put("/bots/:id/identity", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = z
    .object({
      name: z.string().min(1).max(63),
      avatar: z.string().max(2048).default(""),
      personality: z.string().max(4096).default(""),
    })
    .safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  try {
    const updated = await fleet.update(botId, {
      name: parsed.data.name,
      description: parsed.data.personality,
    });
    return c.json({ name: updated.name, avatar: parsed.data.avatar, personality: updated.description });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/capabilities/:capabilityId/activate — Activate a superpower */
fleetRoutes.post("/bots/:id/capabilities/:capabilityId/activate", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const capabilityId = c.req.param("capabilityId") as string;

  const capEntry = CAPABILITY_ENV_MAP[capabilityId];
  if (!capEntry) {
    return c.json({ error: `Unknown capability: ${capabilityId}` }, 400);
  }

  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  const activeKey = `WOPR_CAP_${capabilityId.toUpperCase().replace(/-/g, "_")}_ACTIVE`;
  if (profile.env[activeKey]) {
    return c.json({ success: true, capabilityId, alreadyActive: true });
  }

  try {
    await fleet.update(botId, {
      env: {
        ...profile.env,
        [activeKey]: "1",
      },
    });
    return c.json({ success: true, capabilityId, alreadyActive: false });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/upgrade-to-vps — Initiate VPS upgrade via Stripe subscription checkout */
fleetRoutes.post("/bots/:id/upgrade-to-vps", writeAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  const vpsPriceId = process.env.STRIPE_VPS_PRICE_ID;
  if (!vpsPriceId) {
    return c.json({ error: "VPS tier not configured" }, 503);
  }

  const { getVpsRepo, getTenantCustomerRepository } = await import("../../fleet/services.js");
  const vpsRepo = getVpsRepo();
  const existing = await vpsRepo.getByBotId(botId);
  if (existing && existing.status === "active") {
    return c.json({ error: "Bot already on VPS tier" }, 409);
  }

  const tenantRepo = getTenantCustomerRepository();
  const customer = await tenantRepo.getByTenant(profile.tenantId);
  if (!customer) {
    return c.json(
      {
        error: "No payment method on file. Please add a payment method first.",
        buyUrl: "/dashboard/billing",
      },
      402,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // No body is fine — use defaults
  }

  const baseUrl = process.env.PLATFORM_UI_URL ?? "https://app.wopr.bot";
  const successUrl =
    typeof body.successUrl === "string" ? body.successUrl : `${baseUrl}/dashboard/bots/${botId}?vps=activated`;
  const cancelUrl = typeof body.cancelUrl === "string" ? body.cancelUrl : `${baseUrl}/dashboard/bots/${botId}`;

  if (typeof body.successUrl === "string") {
    try {
      assertSafeRedirectUrl(successUrl);
    } catch {
      return c.json({ error: "Invalid redirect URL" }, 400);
    }
  }
  if (typeof body.cancelUrl === "string") {
    try {
      assertSafeRedirectUrl(cancelUrl);
    } catch {
      return c.json({ error: "Invalid redirect URL" }, 400);
    }
  }

  const { createVpsCheckoutSession } = await import("@wopr-network/platform-core/billing");
  const { createStripeClient, loadStripeConfig } = await import("@wopr-network/platform-core/billing");

  const stripeConfig = loadStripeConfig();
  if (!stripeConfig) {
    return c.json({ error: "Stripe not configured" }, 503);
  }

  const session = await createVpsCheckoutSession(createStripeClient(stripeConfig), tenantRepo, {
    tenant: profile.tenantId,
    botId,
    vpsPriceId,
    successUrl,
    cancelUrl,
  });

  return c.json({ url: session.url, sessionId: session.id });
});

/** GET /fleet/bots/:id/vps-info — Get VPS subscription info for a bot */
fleetRoutes.get("/bots/:id/vps-info", readAuth, async (c) => {
  const botId = c.req.param("id") as string;
  const profile = await fleet.profiles.get(botId);
  const ownershipError = validateTenantOwnership(c, profile, profile?.tenantId);
  if (ownershipError) return ownershipError;
  if (!profile) return c.json({ error: "Bot not found" }, 404);

  const { getVpsRepo } = await import("@wopr-network/platform-core/fleet/services");
  const sub = await getVpsRepo().getByBotId(botId);
  if (!sub) {
    return c.json({ error: "Bot is not on VPS tier" }, 404);
  }

  const sshConnectionString = sub.sshPublicKey ? `ssh root@${sub.hostname ?? `${botId}.bot.wopr.bot`} -p 22` : null;

  return c.json({
    botId: sub.botId,
    status: sub.status,
    hostname: sub.hostname,
    sshConnectionString,
    diskSizeGb: sub.diskSizeGb,
    createdAt: sub.createdAt,
  });
});

/** Export fleet manager and related modules for testing */
export { fleet, FleetManager, imagePoller, updater };
