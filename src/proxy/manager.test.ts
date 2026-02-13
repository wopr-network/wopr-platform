import * as dnsPromises from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyManager } from "./manager.js";
import type { ProxyRoute } from "./types.js";

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

function makeRoute(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  return {
    instanceId: "inst-1",
    upstreamHost: "203.0.113.2",
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
    // Default: DNS resolution returns the host as-is for IPs, public IPs for hostnames
    vi.mocked(dnsPromises.resolve4).mockResolvedValue(["203.0.113.50"]);
    vi.mocked(dnsPromises.resolve6).mockRejectedValue(new Error("ENODATA"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("route management", () => {
    it("adds a route", async () => {
      const route = makeRoute();
      await manager.addRoute(route);

      expect(manager.getRoutes()).toEqual([route]);
    });

    it("removes a route", async () => {
      await manager.addRoute(makeRoute());
      manager.removeRoute("inst-1");

      expect(manager.getRoutes()).toEqual([]);
    });

    it("removing nonexistent route is a no-op", () => {
      manager.removeRoute("nonexistent");
      expect(manager.getRoutes()).toEqual([]);
    });

    it("updates health status", async () => {
      await manager.addRoute(makeRoute({ healthy: true }));
      manager.updateHealth("inst-1", false);

      expect(manager.getRoutes()[0].healthy).toBe(false);
    });

    it("updating health for nonexistent route is a no-op", () => {
      manager.updateHealth("nonexistent", false);
      expect(manager.getRoutes()).toEqual([]);
    });

    it("replaces route with same instanceId", async () => {
      await manager.addRoute(makeRoute({ upstreamHost: "203.0.113.1" }));
      await manager.addRoute(makeRoute({ upstreamHost: "203.0.113.2" }));

      expect(manager.getRoutes()).toHaveLength(1);
      expect(manager.getRoutes()[0].upstreamHost).toBe("203.0.113.2");
    });

    it("manages multiple routes", async () => {
      await manager.addRoute(makeRoute({ instanceId: "a" }));
      await manager.addRoute(makeRoute({ instanceId: "b" }));
      await manager.addRoute(makeRoute({ instanceId: "c" }));

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
      await manager.addRoute(makeRoute());
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
      // Start successfully first
      await manager.start();

      // Now make fetch fail for the next reload
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as Response);

      await expect(manager.reload()).rejects.toThrow("Caddy reload failed (500)");
    });
  });

  describe("SSRF upstream validation", () => {
    it("rejects loopback IPv4 (127.0.0.1)", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "127.0.0.1" }))).rejects.toThrow("private IP");
    });

    it("rejects 10.x.x.x private range", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "10.0.0.5" }))).rejects.toThrow("private IP");
    });

    it("rejects 172.16.x.x private range", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "172.16.0.1" }))).rejects.toThrow("private IP");
    });

    it("rejects 192.168.x.x private range", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "192.168.1.1" }))).rejects.toThrow("private IP");
    });

    it("rejects cloud metadata IP (169.254.169.254)", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "169.254.169.254" }))).rejects.toThrow("private IP");
    });

    it("rejects IPv6 loopback (::1)", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "::1" }))).rejects.toThrow("private IP");
    });

    it("rejects localhost hostname", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "localhost" }))).rejects.toThrow("private IP");
    });

    it("accepts public IP addresses", async () => {
      await expect(manager.addRoute(makeRoute({ upstreamHost: "203.0.113.50" }))).resolves.toBeUndefined();
    });

    it("accepts external hostnames that resolve to public IPs", async () => {
      vi.mocked(dnsPromises.resolve4).mockResolvedValue(["203.0.113.50"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "example.com" }))).resolves.toBeUndefined();
    });
  });

  describe("DNS rebinding protection", () => {
    it("rejects hostname resolving to loopback (127.0.0.1)", async () => {
      vi.mocked(dnsPromises.resolve4).mockResolvedValue(["127.0.0.1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname resolving to private 10.x range", async () => {
      vi.mocked(dnsPromises.resolve4).mockResolvedValue(["10.0.0.1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname resolving to private 172.16.x range", async () => {
      vi.mocked(dnsPromises.resolve4).mockResolvedValue(["172.16.5.1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname resolving to private 192.168.x range", async () => {
      vi.mocked(dnsPromises.resolve4).mockResolvedValue(["192.168.0.1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname resolving to cloud metadata (169.254.169.254)", async () => {
      vi.mocked(dnsPromises.resolve4).mockResolvedValue(["169.254.169.254"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "metadata.evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname resolving to IPv6 loopback (::1)", async () => {
      vi.mocked(dnsPromises.resolve4).mockRejectedValue(new Error("ENODATA"));
      vi.mocked(dnsPromises.resolve6).mockResolvedValue(["::1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname resolving to IPv6 unique local (fd00::)", async () => {
      vi.mocked(dnsPromises.resolve4).mockRejectedValue(new Error("ENODATA"));
      vi.mocked(dnsPromises.resolve6).mockResolvedValue(["fd00::1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname resolving to IPv6 link-local (fe80::)", async () => {
      vi.mocked(dnsPromises.resolve4).mockRejectedValue(new Error("ENODATA"));
      vi.mocked(dnsPromises.resolve6).mockResolvedValue(["fe80::1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "evil.com" }))).rejects.toThrow("private IP");
    });

    it("rejects when any resolved IP is private (mixed results)", async () => {
      vi.mocked(dnsPromises.resolve4).mockResolvedValue(["203.0.113.50", "10.0.0.1"]);
      await expect(manager.addRoute(makeRoute({ upstreamHost: "sneaky.com" }))).rejects.toThrow("private IP");
    });

    it("rejects hostname that cannot be resolved", async () => {
      vi.mocked(dnsPromises.resolve4).mockRejectedValue(new Error("ENOTFOUND"));
      vi.mocked(dnsPromises.resolve6).mockRejectedValue(new Error("ENOTFOUND"));
      await expect(manager.addRoute(makeRoute({ upstreamHost: "nonexistent.invalid" }))).rejects.toThrow(
        "could not be resolved",
      );
    });

    it("rejects .internal hostname before DNS lookup", async () => {
      vi.mocked(dnsPromises.resolve4).mockClear();
      await expect(manager.addRoute(makeRoute({ upstreamHost: "secret.internal" }))).rejects.toThrow("private IP");
      expect(dnsPromises.resolve4).not.toHaveBeenCalled();
    });

    it("rejects .local hostname before DNS lookup", async () => {
      vi.mocked(dnsPromises.resolve4).mockClear();
      await expect(manager.addRoute(makeRoute({ upstreamHost: "printer.local" }))).rejects.toThrow("private IP");
      expect(dnsPromises.resolve4).not.toHaveBeenCalled();
    });
  });

  describe("subdomain validation", () => {
    it("rejects subdomain with path traversal", async () => {
      await expect(manager.addRoute(makeRoute({ subdomain: "../etc" }))).rejects.toThrow("Invalid subdomain");
    });

    it("rejects subdomain with slash", async () => {
      await expect(manager.addRoute(makeRoute({ subdomain: "foo/bar" }))).rejects.toThrow("Invalid subdomain");
    });

    it("rejects subdomain starting with hyphen", async () => {
      await expect(manager.addRoute(makeRoute({ subdomain: "-invalid" }))).rejects.toThrow("Invalid subdomain");
    });

    it("rejects subdomain with uppercase", async () => {
      await expect(manager.addRoute(makeRoute({ subdomain: "UPPER" }))).rejects.toThrow("Invalid subdomain");
    });

    it("rejects empty subdomain", async () => {
      await expect(manager.addRoute(makeRoute({ subdomain: "" }))).rejects.toThrow("Invalid subdomain");
    });

    it("accepts valid subdomain", async () => {
      await expect(manager.addRoute(makeRoute({ subdomain: "my-app-1" }))).resolves.toBeUndefined();
    });

    it("accepts single-char subdomain", async () => {
      await expect(manager.addRoute(makeRoute({ subdomain: "a" }))).resolves.toBeUndefined();
    });
  });

  describe("start rollback on failure", () => {
    it("calls stop() if reload fails during start()", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("connection refused"));

      await expect(manager.start()).rejects.toThrow("connection refused");
      expect(manager.isRunning).toBe(false);
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
      await custom.addRoute(makeRoute());
      await custom.start();

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      const match = body.apps.http.servers.proxy.routes[0].match[0];
      expect(match.host[0]).toBe("inst-1.test.dev");
    });
  });
});
