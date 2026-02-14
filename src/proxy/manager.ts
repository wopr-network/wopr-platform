import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { logger } from "../config/logger.js";
import type { CaddyConfigOptions } from "./caddy-config.js";
import { generateCaddyConfig } from "./caddy-config.js";
import type { ProxyManagerInterface, ProxyRoute } from "./types.js";

/**
 * Normalize an IPv6 address to its full canonical form for reliable comparison.
 * Expands :: shorthand and pads each group to 4 hex digits.
 */
function normalizeIPv6(ip: string): string {
  // Handle IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const v4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) {
    return `v4mapped:${v4MappedMatch[1]}`;
  }

  // Split on :: to expand the zero-fill shorthand
  const halves = ip.split("::");
  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    const fill = Array(missing).fill("0000");
    groups = [...left, ...fill, ...right];
  } else {
    groups = ip.split(":");
  }

  return groups.map((g) => g.padStart(4, "0").toLowerCase()).join(":");
}

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
 * Normalizes to canonical form first to catch non-standard representations.
 */
function isPrivateIPv6(ip: string): boolean {
  const canonical = normalizeIPv6(ip);

  // Handle IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) — delegate to IPv4 check
  if (canonical.startsWith("v4mapped:")) {
    return isPrivateIPv4(canonical.slice("v4mapped:".length));
  }

  return (
    canonical === "0000:0000:0000:0000:0000:0000:0000:0001" || // ::1 loopback
    canonical.startsWith("fe80") || // link-local
    canonical.startsWith("fc") || // unique local
    canonical.startsWith("fd") || // unique local
    canonical === "0000:0000:0000:0000:0000:0000:0000:0000" // :: unspecified
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

  // It's a hostname — normalize to lowercase since DNS is case-insensitive
  const normalizedHost = host.toLowerCase();

  // Reject obviously dangerous names first
  if (normalizedHost === "localhost" || normalizedHost.endsWith(".local") || normalizedHost.endsWith(".internal")) {
    throw new Error(`Upstream host "${host}" resolves to a private IP address`);
  }

  // Resolve DNS and validate all resulting IPs
  const ips: string[] = [];
  let v4NotFound = false;
  try {
    const ipv4 = await resolve4(normalizedHost);
    ips.push(...ipv4);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      v4NotFound = true; // No A records — host may be IPv6-only
    } else {
      throw new Error(`DNS resolution failed for "${host}": ${code ?? "unknown error"}`);
    }
  }
  try {
    const ipv6 = await resolve6(normalizedHost);
    ips.push(...ipv6);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      // No AAAA records — host may be IPv4-only
    } else if (v4NotFound) {
      // Both lookups failed with non-ENOTFOUND — reject
      throw new Error(`DNS resolution failed for "${host}": ${code ?? "unknown error"}`);
    }
    // If v4 succeeded but v6 fails transiently, we still have IPs to check
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
