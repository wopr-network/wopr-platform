import { logger } from "../config/logger.js";
import type { CaddyConfigOptions } from "./caddy-config.js";
import { generateCaddyConfig } from "./caddy-config.js";
import type { ProxyManagerInterface, ProxyRoute } from "./types.js";

const DEFAULT_CADDY_ADMIN_URL = "http://localhost:2019";

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

  addRoute(route: ProxyRoute): void {
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
    await this.reload();
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
