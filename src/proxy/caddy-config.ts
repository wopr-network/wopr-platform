import type { CaddyConfig, CaddyRoute, ProxyRoute } from "./types.js";

const DEFAULT_DOMAIN = "wopr.bot";

export interface CaddyConfigOptions {
  /** Base domain for subdomain routing (default: "wopr.bot") */
  domain?: string;
  /** HTTP listen addresses (default: [":443"]) */
  listenAddresses?: string[];
}

/**
 * Build a Caddy reverse_proxy route for a healthy upstream.
 */
function buildProxyRoute(route: ProxyRoute, domain: string): CaddyRoute[] {
  const upstream = `${route.upstreamHost}:${route.upstreamPort}`;
  const routes: CaddyRoute[] = [];

  if (route.healthy) {
    // Subdomain route: {instanceId}.wopr.bot
    routes.push({
      match: [{ host: [`${route.subdomain}.${domain}`] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: upstream }],
        },
      ],
    });

    // Path route: /instance/{instanceId}/*
    routes.push({
      match: [{ path: [`/instance/${route.instanceId}/*`] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: upstream }],
        },
      ],
    });
  } else {
    // Unhealthy: return 503 for both subdomain and path routes
    const unavailableHandler = {
      handler: "static_response" as const,
      status_code: "503",
      body: `Instance ${route.instanceId} is unavailable`,
      headers: { "Content-Type": ["text/plain"] },
    };

    routes.push({
      match: [{ host: [`${route.subdomain}.${domain}`] }],
      handle: [unavailableHandler],
    });

    routes.push({
      match: [{ path: [`/instance/${route.instanceId}/*`] }],
      handle: [unavailableHandler],
    });
  }

  return routes;
}

/**
 * Generate a complete Caddy JSON config from a set of proxy routes.
 */
export function generateCaddyConfig(routes: ProxyRoute[], options: CaddyConfigOptions = {}): CaddyConfig {
  const domain = options.domain ?? DEFAULT_DOMAIN;
  const listenAddresses = options.listenAddresses ?? [":443"];

  const caddyRoutes: CaddyRoute[] = routes.flatMap((route) => buildProxyRoute(route, domain));

  return {
    apps: {
      http: {
        servers: {
          proxy: {
            listen: listenAddresses,
            routes: caddyRoutes,
          },
        },
      },
    },
  };
}
