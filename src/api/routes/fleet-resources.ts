// src/api/routes/fleet-resources.ts
import Docker from "dockerode";
import { Hono } from "hono";
import type { AuditEnv } from "../../audit/types.js";
import { config } from "../../config/index.js";
import { FleetManager } from "../../fleet/fleet-manager.js";
import { ProfileStore } from "../../fleet/profile-store.js";
import { NetworkPolicy } from "../../network/network-policy.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";

let _fleet: FleetManager | null = null;
function getFleet(): FleetManager {
  if (!_fleet) {
    const docker = new Docker();
    const store = new ProfileStore(DATA_DIR);
    const networkPolicy = new NetworkPolicy(docker);
    _fleet = new FleetManager(docker, store, config.discovery, networkPolicy);
  }
  return _fleet;
}

/** Inject a FleetManager for testing (pass null to reset). */
export function setFleetManager(fm: FleetManager | null): void {
  _fleet = fm;
}

export const fleetResourceRoutes = new Hono<AuditEnv>();

/**
 * GET /api/fleet/resources
 *
 * Aggregated CPU/memory summary across all running bot instances.
 * This endpoint is under /api/* (session auth), not /fleet/* (bearer auth).
 */
fleetResourceRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const bots = await getFleet().listByTenant(user.id);

  let totalCpuPercent = 0;
  let totalMemoryMb = 0;
  let memoryCapacityMb = 0;

  for (const bot of bots) {
    if (bot.stats) {
      totalCpuPercent += bot.stats.cpuPercent;
      totalMemoryMb += bot.stats.memoryUsageMb;
      memoryCapacityMb += bot.stats.memoryLimitMb;
    }
  }

  return c.json({
    totalCpuPercent: Math.round(totalCpuPercent * 100) / 100,
    totalMemoryMb,
    memoryCapacityMb,
  });
});
