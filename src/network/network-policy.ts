import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import { TenantNetworkManager } from "./tenant-network.js";
import { PLATFORM_NETWORK_NAME } from "./types.js";

/**
 * Enforces network isolation policies for tenant containers.
 *
 * Coordinates between the TenantNetworkManager and container lifecycle:
 * - Ensures tenant network exists before container creation
 * - Returns the NetworkMode for container HostConfig
 * - Cleans up tenant network when last container is removed
 * - Keeps platform network separate from tenant networks
 */
export class NetworkPolicy {
  private readonly networkManager: TenantNetworkManager;

  constructor(docker: Docker) {
    this.networkManager = new TenantNetworkManager(docker);
  }

  /**
   * Prepare network for a new container. Ensures the tenant network
   * exists and returns the NetworkMode string for HostConfig.
   *
   * Call this BEFORE creating a container.
   */
  async prepareForContainer(tenantId: string): Promise<string> {
    const network = await this.networkManager.ensureTenantNetwork({ tenantId });
    const networkMode = network.networkName;
    logger.info(`Prepared network ${networkMode} for tenant ${tenantId}`);
    return networkMode;
  }

  /**
   * Clean up after a container is removed. If no more containers
   * exist on the tenant network, remove it.
   *
   * Call this AFTER removing a container.
   */
  async cleanupAfterRemoval(tenantId: string): Promise<void> {
    const count = await this.networkManager.getContainerCount(tenantId);

    if (count === 0) {
      logger.info(`No containers left for tenant ${tenantId}, removing network`);
      try {
        await this.networkManager.removeTenantNetwork(tenantId);
      } catch (err: unknown) {
        // Handle race condition: another concurrent removal already deleted
        // the network, or containers were attached between our count check
        // and the removal attempt. Both are benign -- log and move on.
        logger.warn(`Failed to remove network for tenant ${tenantId}, may have been removed concurrently`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.info(`Tenant ${tenantId} still has ${count} container(s), keeping network`);
    }
  }

  /**
   * Check whether a tenant's containers are properly isolated.
   * Returns true if the tenant has a dedicated network.
   */
  async isIsolated(tenantId: string): Promise<boolean> {
    const network = await this.networkManager.getTenantNetwork(tenantId);
    return network !== null;
  }

  /**
   * Ensure the platform management network exists.
   * Should be called during platform startup.
   */
  async ensurePlatformNetwork(): Promise<string> {
    return this.networkManager.ensurePlatformNetwork();
  }

  /**
   * Get the network mode string that should be used for a container's HostConfig.
   * This is the tenant network name.
   */
  static getNetworkMode(tenantId: string): string {
    return TenantNetworkManager.networkNameFor(tenantId);
  }

  /**
   * Get the platform management network name.
   */
  static getPlatformNetworkName(): string {
    return PLATFORM_NETWORK_NAME;
  }

  /**
   * Access the underlying network manager for advanced operations.
   */
  get networks(): TenantNetworkManager {
    return this.networkManager;
  }
}
