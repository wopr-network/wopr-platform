import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEnv } from "../../audit/types.js";
import { fleetResourceRoutes, setFleetManager } from "./fleet-resources.js";

// Build a test app with session user already injected
function makeApp(user: { id: string; roles: string[] } | null = { id: "user-123", roles: ["user"] }) {
  const app = new Hono<AuditEnv>();
  app.use("/*", async (c, next) => {
    if (user) {
      c.set("user", user);
    }
    return next();
  });
  app.route("/api/fleet/resources", fleetResourceRoutes);
  return app;
}

function makeMockFleet(
  bots: { stats: { cpuPercent: number; memoryUsageMb: number; memoryLimitMb: number; memoryPercent: number } | null }[],
) {
  return {
    listByTenant: vi.fn().mockResolvedValue(bots),
  };
}

beforeEach(() => {
  setFleetManager(null as unknown as import("../../fleet/fleet-manager.js").FleetManager);
});

describe("GET /api/fleet/resources", () => {
  it("returns 401 when no user session", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/fleet/resources");
    expect(res.status).toBe(401);
  });

  it("returns zero stats when no bots are running", async () => {
    setFleetManager(makeMockFleet([]) as unknown as import("../../fleet/fleet-manager.js").FleetManager);

    const app = makeApp();
    const res = await app.request("/api/fleet/resources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalCpuPercent: number;
      totalMemoryMb: number;
      memoryCapacityMb: number;
    };
    expect(body.totalCpuPercent).toBe(0);
    expect(body.totalMemoryMb).toBe(0);
    expect(body.memoryCapacityMb).toBe(0);
  });

  it("aggregates CPU and memory across running bots", async () => {
    setFleetManager(
      makeMockFleet([
        { stats: { cpuPercent: 10.5, memoryUsageMb: 256, memoryLimitMb: 512, memoryPercent: 50 } },
        { stats: { cpuPercent: 20.3, memoryUsageMb: 128, memoryLimitMb: 256, memoryPercent: 50 } },
      ]) as unknown as import("../../fleet/fleet-manager.js").FleetManager,
    );

    const app = makeApp();
    const res = await app.request("/api/fleet/resources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalCpuPercent: number;
      totalMemoryMb: number;
      memoryCapacityMb: number;
    };
    expect(body.totalCpuPercent).toBe(30.8); // 10.5 + 20.3 rounded to 2 decimals
    expect(body.totalMemoryMb).toBe(384); // 256 + 128
    expect(body.memoryCapacityMb).toBe(768); // 512 + 256
  });

  it("handles bots with null stats (stopped bots)", async () => {
    setFleetManager(
      makeMockFleet([
        { stats: { cpuPercent: 15, memoryUsageMb: 200, memoryLimitMb: 400, memoryPercent: 50 } },
        { stats: null }, // stopped bot
        { stats: null }, // stopped bot
      ]) as unknown as import("../../fleet/fleet-manager.js").FleetManager,
    );

    const app = makeApp();
    const res = await app.request("/api/fleet/resources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalCpuPercent: number;
      totalMemoryMb: number;
      memoryCapacityMb: number;
    };
    expect(body.totalCpuPercent).toBe(15);
    expect(body.totalMemoryMb).toBe(200);
    expect(body.memoryCapacityMb).toBe(400);
  });

  it("returns response shape matching FleetResources interface", async () => {
    setFleetManager(makeMockFleet([]) as unknown as import("../../fleet/fleet-manager.js").FleetManager);

    const app = makeApp();
    const res = await app.request("/api/fleet/resources");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("totalCpuPercent");
    expect(body).toHaveProperty("totalMemoryMb");
    expect(body).toHaveProperty("memoryCapacityMb");
  });

  it("only aggregates the authenticated user's bots (tenant isolation)", async () => {
    const mockFleet = makeMockFleet([
      { stats: { cpuPercent: 10, memoryUsageMb: 100, memoryLimitMb: 200, memoryPercent: 50 } },
    ]);
    setFleetManager(mockFleet as unknown as import("../../fleet/fleet-manager.js").FleetManager);

    const app = makeApp({ id: "user-123", roles: ["user"] });
    const res = await app.request("/api/fleet/resources");
    expect(res.status).toBe(200);
    expect(mockFleet.listByTenant).toHaveBeenCalledWith("user-123");
  });
});
