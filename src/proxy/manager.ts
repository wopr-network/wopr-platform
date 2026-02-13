import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { logger } from "../config/logger.js";
import type { CaddyConfigOptions } from "./caddy-config.js";
import { generateCaddyConfig } from "./caddy-config.js";
import type { ProxyManagerInterface, ProxyRoute } from "./types.js";

const DEFAULT_CADDY_ADMIN_URL = "http://localhost:2019";

/** Regex for valid DNS subdomain labels (RFC 1123). */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Returns true if the given IPv4 address string belongs to a private/reserved range.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return (
    a === 127 || // 127.0.0.0/8  loopback
    a === 10 || // 10.0.0.0/8   private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    a === 0 // 0.0.0.0/8
  );
}

/**
 * Returns true if the given IPv6 address string belongs to a private/reserved range.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" || // loopback
    normalized.startsWith("fe80") || // link-local
    normalized.startsWith("fc") || // unique local
    normalized.startsWith("fd") || // unique local
    normalized === "::" // unspecified
  );
}

/**
 * Validate that an upstream host is not a private/internal IP address.
 * Resolves hostnames via DNS and checks all resolved IPs against private ranges.
 * Throws if the host resolves to or is a private IP.
 */
async function validateUpstreamHost(host: string): Promise<void> {
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    if (isPrivateIPv4(host)) {
      throw new Error(`Upstream host "${host}" resolves to a private IP address`);
    }
    return;
  }
  if (ipVersion === 6) {
    if (isPrivateIPv6(host)) {
      throw new Error(`Upstream host "${host}" resolves to a private IP address`);
    }
    return;
  }

  // It's a hostname — reject obviously dangerous names first
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Upstream host "${host}" resolves to a private IP address`);
  }

  // Resolve DNS and validate all resulting IPs
  const ips: string[] = [];
  try {
    const ipv4 = await resolve4(host);
    ips.push(...ipv4);
  } catch {
    // No A records — not an error, host may be IPv6-only
  }
  try {
    const ipv6 = await resolve6(host);
    ips.push(...ipv6);
  } catch {
    // No AAAA records — not an error, host may be IPv4-only
  }

  if (ips.length === 0) {
    throw new Error(`Upstream host "${host}" could not be resolved`);
  }

  for (const ip of ips) {
    if (isIP(ip) === 4 && isPrivateIPv4(ip)) {
      throw new Error(`Upstream host "${host}" resolves to a private IP address`);
    }
    if (isIP(ip) === 6 && isPrivateIPv6(ip)) {
      throw new Error(`Upstream host "${host}" resolves to a private IP address`);
    }
  }
}

export interface ProxyManagerOptions extends CaddyConfigOptions {
  /** Caddy admin API URL (default: "http://localhost:2019") */
  caddyAdminUrl?: string;
}

/**
 * Manages proxy routes and syncs them to Caddy via its admin API.
 */
export class ProxyManager implements ProxyManagerInterface {
  private readonly routes = new Map<string, ProxyRoute>();
  private readonly caddyAdminUrl: string;
  private readonly configOptions: CaddyConfigOptions;
  private running = false;

  constructor(options: ProxyManagerOptions = {}) {
    const { caddyAdminUrl, ...configOptions } = options;
    this.caddyAdminUrl = caddyAdminUrl ?? DEFAULT_CADDY_ADMIN_URL;
    this.configOptions = configOptions;
  }

  async addRoute(route: ProxyRoute): Promise<void> {
    if (!SUBDOMAIN_RE.test(route.subdomain)) {
      throw new Error(`Invalid subdomain "${route.subdomain}": must match /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/`);
    }
    await validateUpstreamHost(route.upstreamHost);
    this.routes.set(route.instanceId, route);
    logger.info(`Added proxy route for instance ${route.instanceId} -> ${route.upstreamHost}:${route.upstreamPort}`);
  }

  removeRoute(instanceId: string): void {
    const removed = this.routes.delete(instanceId);
    if (removed) {
      logger.info(`Removed proxy route for instance ${instanceId}`);
    }
  }

  updateHealth(instanceId: string, healthy: boolean): void {
    const route = this.routes.get(instanceId);
    if (route) {
      route.healthy = healthy;
      logger.info(`Updated health for instance ${instanceId}: ${healthy ? "healthy" : "unhealthy"}`);
    }
  }

  getRoutes(): ProxyRoute[] {
    return [...this.routes.values()];
  }

  /**
   * Mark the proxy manager as started. Does not start Caddy itself --
   * Caddy is expected to be running as a separate process/container.
   */
  async start(): Promise<void> {
    this.running = true;
    logger.info("Proxy manager started");
    try {
      await this.reload();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    logger.info("Proxy manager stopped");
  }

  /**
   * Push current route config to Caddy via its admin API.
   */
  async reload(): Promise<void> {
    if (!this.running) {
      logger.warn("Proxy manager not running, skipping reload");
      return;
    }

    const config = generateCaddyConfig(this.getRoutes(), this.configOptions);
    const url = `${this.caddyAdminUrl}/load`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Caddy reload failed (${response.status}): ${body}`);
      }

      logger.info(`Caddy config reloaded with ${this.routes.size} route(s)`);
    } catch (err) {
      logger.error("Failed to reload Caddy config", { err });
      throw err;
    }
  }

  /** Whether the proxy manager is currently active. */
  get isRunning(): boolean {
    return this.running;
  }
}
