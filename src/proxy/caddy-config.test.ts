import { describe, expect, it } from "vitest";
import { generateCaddyConfig } from "./caddy-config.js";
import type { ProxyRoute } from "./types.js";

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

describe("generateCaddyConfig", () => {
  it("generates empty config with no routes", () => {
    const config = generateCaddyConfig([]);

    expect(config.apps.http.servers.proxy.routes).toEqual([]);
    expect(config.apps.http.servers.proxy.listen).toEqual([":443"]);
  });

  it("generates subdomain and path routes for a healthy instance", () => {
    const config = generateCaddyConfig([makeRoute()]);
    const routes = config.apps.http.servers.proxy.routes;

    // Should have 2 routes: subdomain + path
    expect(routes).toHaveLength(2);

    // Subdomain route
    expect(routes[0].match).toEqual([{ host: ["inst-1.wopr.bot"] }]);
    expect(routes[0].handle).toEqual([{ handler: "reverse_proxy", upstreams: [{ dial: "203.0.113.2:7437" }] }]);

    // Path route
    expect(routes[1].match).toEqual([{ path: ["/instance/inst-1/*"] }]);
    expect(routes[1].handle).toEqual([{ handler: "reverse_proxy", upstreams: [{ dial: "203.0.113.2:7437" }] }]);
  });

  it("generates 503 responses for unhealthy instances", () => {
    const config = generateCaddyConfig([makeRoute({ healthy: false })]);
    const routes = config.apps.http.servers.proxy.routes;

    expect(routes).toHaveLength(2);

    for (const route of routes) {
      expect(route.handle[0]).toEqual(
        expect.objectContaining({
          handler: "static_response",
          status_code: "503",
        }),
      );
    }
  });

  it("handles multiple routes", () => {
    const routes = [
      makeRoute({ instanceId: "a", subdomain: "a", upstreamHost: "203.0.113.1" }),
      makeRoute({ instanceId: "b", subdomain: "b", upstreamHost: "203.0.113.2" }),
      makeRoute({ instanceId: "c", subdomain: "c", upstreamHost: "203.0.113.3", healthy: false }),
    ];

    const config = generateCaddyConfig(routes);
    const caddyRoutes = config.apps.http.servers.proxy.routes;

    // 2 routes per instance (subdomain + path) = 6 total
    expect(caddyRoutes).toHaveLength(6);

    // First two are healthy reverse_proxy
    expect(caddyRoutes[0].handle[0].handler).toBe("reverse_proxy");
    expect(caddyRoutes[1].handle[0].handler).toBe("reverse_proxy");

    // Last two are unhealthy static_response
    expect(caddyRoutes[4].handle[0].handler).toBe("static_response");
    expect(caddyRoutes[5].handle[0].handler).toBe("static_response");
  });

  it("uses custom domain option", () => {
    const config = generateCaddyConfig([makeRoute()], { domain: "custom.dev" });
    const routes = config.apps.http.servers.proxy.routes;

    expect(routes[0].match).toEqual([{ host: ["inst-1.custom.dev"] }]);
  });

  it("uses custom listen addresses", () => {
    const config = generateCaddyConfig([], { listenAddresses: [":8080", ":8443"] });

    expect(config.apps.http.servers.proxy.listen).toEqual([":8080", ":8443"]);
  });

  it("routes WebSocket traffic via reverse_proxy (Caddy auto-upgrades)", () => {
    // Caddy's reverse_proxy automatically handles WebSocket upgrade headers,
    // so no special config is needed. We verify the reverse_proxy handler is used.
    const config = generateCaddyConfig([makeRoute()]);
    const routes = config.apps.http.servers.proxy.routes;

    const proxyHandlers = routes.filter((r) => r.handle[0].handler === "reverse_proxy");
    expect(proxyHandlers.length).toBeGreaterThan(0);

    for (const route of proxyHandlers) {
      expect(route.handle[0]).toHaveProperty("upstreams");
    }
  });

  it("uses correct upstream dial format", () => {
    const route = makeRoute({ upstreamHost: "198.51.100.50", upstreamPort: 9000 });
    const config = generateCaddyConfig([route]);
    const caddyRoutes = config.apps.http.servers.proxy.routes;

    const handler = caddyRoutes[0].handle[0];
    expect(handler).toEqual(
      expect.objectContaining({
        handler: "reverse_proxy",
        upstreams: [{ dial: "198.51.100.50:9000" }],
      }),
    );
  });
});
