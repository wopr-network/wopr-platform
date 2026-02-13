import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyManager } from "./manager.js";
import type { ProxyRoute } from "./types.js";

function makeRoute(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  return {
    instanceId: "inst-1",
    upstreamHost: "172.17.0.2",
    upstreamPort: 7437,
    subdomain: "inst-1",
    healthy: true,
    ...overrides,
  };
}

describe("ProxyManager", () => {
  let manager: ProxyManager;

  beforeEach(() => {
    manager = new ProxyManager({ caddyAdminUrl: "http://localhost:2019" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("route management", () => {
    it("adds a route", () => {
      const route = makeRoute();
      manager.addRoute(route);

      expect(manager.getRoutes()).toEqual([route]);
    });

    it("removes a route", () => {
      manager.addRoute(makeRoute());
      manager.removeRoute("inst-1");

      expect(manager.getRoutes()).toEqual([]);
    });

    it("removing nonexistent route is a no-op", () => {
      manager.removeRoute("nonexistent");
      expect(manager.getRoutes()).toEqual([]);
    });

    it("updates health status", () => {
      manager.addRoute(makeRoute({ healthy: true }));
      manager.updateHealth("inst-1", false);

      expect(manager.getRoutes()[0].healthy).toBe(false);
    });

    it("updating health for nonexistent route is a no-op", () => {
      manager.updateHealth("nonexistent", false);
      expect(manager.getRoutes()).toEqual([]);
    });

    it("replaces route with same instanceId", () => {
      manager.addRoute(makeRoute({ upstreamHost: "10.0.0.1" }));
      manager.addRoute(makeRoute({ upstreamHost: "10.0.0.2" }));

      expect(manager.getRoutes()).toHaveLength(1);
      expect(manager.getRoutes()[0].upstreamHost).toBe("10.0.0.2");
    });

    it("manages multiple routes", () => {
      manager.addRoute(makeRoute({ instanceId: "a" }));
      manager.addRoute(makeRoute({ instanceId: "b" }));
      manager.addRoute(makeRoute({ instanceId: "c" }));

      expect(manager.getRoutes()).toHaveLength(3);

      manager.removeRoute("b");
      expect(manager.getRoutes()).toHaveLength(2);
      expect(manager.getRoutes().map((r) => r.instanceId)).toEqual(["a", "c"]);
    });
  });

  describe("lifecycle", () => {
    it("starts and sets running state", async () => {
      expect(manager.isRunning).toBe(false);
      await manager.start();
      expect(manager.isRunning).toBe(true);
    });

    it("stops and clears running state", async () => {
      await manager.start();
      await manager.stop();
      expect(manager.isRunning).toBe(false);
    });

    it("calls Caddy admin API on start", async () => {
      await manager.start();

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:2019/load",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
  });

  describe("reload", () => {
    it("skips reload when not running", async () => {
      await manager.reload();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("sends config to Caddy on reload", async () => {
      manager.addRoute(makeRoute());
      await manager.start();

      // Clear the start() call
      vi.mocked(fetch).mockClear();

      await manager.reload();

      expect(fetch).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(fetch).mock.calls[0];
      expect(callArgs[0]).toBe("http://localhost:2019/load");

      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.apps.http.servers.proxy.routes).toHaveLength(2); // subdomain + path
    });

    it("throws on Caddy API failure", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as Response);

      await manager.start().catch(() => {});
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as Response);

      await expect(manager.reload()).rejects.toThrow("Caddy reload failed (500)");
    });
  });

  describe("config options", () => {
    it("uses custom Caddy admin URL", async () => {
      const custom = new ProxyManager({ caddyAdminUrl: "http://caddy:2020" });
      await custom.start();

      expect(fetch).toHaveBeenCalledWith("http://caddy:2020/load", expect.anything());
    });

    it("passes domain option to config generator", async () => {
      const custom = new ProxyManager({
        caddyAdminUrl: "http://localhost:2019",
        domain: "test.dev",
      });
      custom.addRoute(makeRoute());
      await custom.start();

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      const match = body.apps.http.servers.proxy.routes[0].match[0];
      expect(match.host[0]).toBe("inst-1.test.dev");
    });
  });
});
