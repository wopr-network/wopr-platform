/** A single proxy route mapping a tenant to an upstream container. */
export interface ProxyRoute {
  instanceId: string;
  upstreamHost: string;
  upstreamPort: number;
  subdomain: string;
  healthy: boolean;
}

/** Caddy route match condition. */
export interface CaddyMatchHost {
  host: string[];
}

export interface CaddyMatchPath {
  path: string[];
}

/** Caddy reverse_proxy handler. */
export interface CaddyReverseProxyHandler {
  handler: "reverse_proxy";
  upstreams: { dial: string }[];
}

/** Caddy static_response handler (for unhealthy upstreams). */
export interface CaddyStaticResponseHandler {
  handler: "static_response";
  status_code: string;
  body: string;
  headers: Record<string, string[]>;
}

/** A single Caddy route entry. */
export interface CaddyRoute {
  match: (CaddyMatchHost | CaddyMatchPath)[];
  handle: (CaddyReverseProxyHandler | CaddyStaticResponseHandler)[];
}

/** Caddy server configuration. */
export interface CaddyServer {
  listen: string[];
  routes: CaddyRoute[];
}

/** Top-level Caddy JSON config. */
export interface CaddyConfig {
  apps: {
    http: {
      servers: Record<string, CaddyServer>;
    };
  };
}

/** Interface for proxy management operations. */
export interface ProxyManagerInterface {
  addRoute(route: ProxyRoute): Promise<void>;
  removeRoute(instanceId: string): void;
  updateHealth(instanceId: string, healthy: boolean): void;
  getRoutes(): ProxyRoute[];
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;
}
