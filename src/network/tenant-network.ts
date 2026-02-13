import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import {
  type CreateTenantNetworkOptions,
  NETWORK_LABELS,
  PLATFORM_NETWORK_NAME,
  type PlatformNetworkOptions,
  TENANT_NETWORK_PREFIX,
  type TenantNetwork,
} from "./types.js";

/**
 * Manages tenant-isolated Docker networks.
 *
 * Each tenant gets a dedicated bridge network. Containers within the same
 * tenant network can communicate (for P2P), but cross-tenant traffic is
 * blocked by Docker's network isolation. The platform management network
 * is separate and used only by control-plane services.
 */
export class TenantNetworkManager {
  private readonly docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  /**
   * Get the Docker network name for a tenant.
   * Sanitizes the tenantId so the resulting name is valid for Docker
   * (must match [a-zA-Z0-9][a-zA-Z0-9_.-]*).
   */
  static networkNameFor(tenantId: string): string {
    if (!tenantId) {
      throw new InvalidTenantIdError(tenantId);
    }
    // Replace any character not in [a-zA-Z0-9_.-] with a hyphen
    const sanitized = tenantId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    // Ensure the first character of the full name is alphanumeric.
    // The prefix starts with a letter so this is already satisfied,
    // but guard against an empty sanitized string.
    if (!sanitized) {
      throw new InvalidTenantIdError(tenantId);
    }
    return `${TENANT_NETWORK_PREFIX}${sanitized}`;
  }

  /**
   * Ensure a tenant network exists. Creates it if it doesn't exist,
   * returns existing network info if it does.
   *
   * Called when creating a user's first instance. Safe to call multiple
   * times — idempotent.
   */
  async ensureTenantNetwork(options: CreateTenantNetworkOptions): Promise<TenantNetwork> {
    const networkName = TenantNetworkManager.networkNameFor(options.tenantId);

    // Check if network already exists
    const existing = await this.findNetwork(networkName);
    if (existing) {
      logger.info(`Tenant network ${networkName} already exists`);
      return this.inspectToTenantNetwork(existing, options.tenantId);
    }

    // ICC defaults to true — same-tenant instances need to communicate for P2P
    const enableIcc = options.enableIcc !== false;

    const networkOpts: Docker.NetworkCreateOptions = {
      Name: networkName,
      Driver: "bridge",
      Internal: false, // instances need internet for provider APIs
      Labels: {
        [NETWORK_LABELS.managed]: "true",
        [NETWORK_LABELS.tenantId]: options.tenantId,
        [NETWORK_LABELS.networkType]: "tenant",
      },
      Options: {
        "com.docker.network.bridge.enable_icc": enableIcc ? "true" : "false",
      },
    };

    if (options.subnet) {
      networkOpts.IPAM = {
        Driver: "default",
        Config: [{ Subnet: options.subnet }],
      };
    }

    try {
      const network = await this.docker.createNetwork(networkOpts);
      logger.info(`Created tenant network ${networkName} (id: ${network.id})`);

      return {
        networkId: network.id,
        tenantId: options.tenantId,
        networkName,
        containerCount: 0,
        createdAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      // Handle race condition: another process created the network between
      // our findNetwork check and createNetwork call (Docker 409 Conflict).
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 409) {
        logger.info(`Tenant network ${networkName} was created concurrently, using existing`);
        const existing = await this.findNetwork(networkName);
        if (existing) {
          return this.inspectToTenantNetwork(existing, options.tenantId);
        }
      }
      throw err;
    }
  }

  /**
   * Remove a tenant network. Should be called when the last instance
   * for a tenant is destroyed.
   *
   * Throws if the network has attached containers.
   */
  async removeTenantNetwork(tenantId: string): Promise<void> {
    const networkName = TenantNetworkManager.networkNameFor(tenantId);
    const network = await this.findNetwork(networkName);

    if (!network) {
      logger.info(`Tenant network ${networkName} does not exist, nothing to remove`);
      return;
    }

    const info = await network.inspect();
    const attachedContainers = Object.keys(info.Containers || {}).length;

    if (attachedContainers > 0) {
      throw new NetworkInUseError(networkName, attachedContainers);
    }

    await network.remove();
    logger.info(`Removed tenant network ${networkName}`);
  }

  /**
   * Get info about a tenant's network, or null if it doesn't exist.
   */
  async getTenantNetwork(tenantId: string): Promise<TenantNetwork | null> {
    const networkName = TenantNetworkManager.networkNameFor(tenantId);
    const network = await this.findNetwork(networkName);

    if (!network) return null;
    return this.inspectToTenantNetwork(network, tenantId);
  }

  /**
   * List all managed tenant networks.
   */
  async listTenantNetworks(): Promise<TenantNetwork[]> {
    const networks = await this.docker.listNetworks({
      filters: {
        label: [`${NETWORK_LABELS.managed}=true`, `${NETWORK_LABELS.networkType}=tenant`],
      },
    });

    const results: TenantNetwork[] = [];
    for (const net of networks) {
      const tenantId = net.Labels?.[NETWORK_LABELS.tenantId];
      if (tenantId) {
        const network = this.docker.getNetwork(net.Id);
        results.push(await this.inspectToTenantNetwork(network, tenantId));
      }
    }

    return results;
  }

  /**
   * Ensure the platform management network exists. Control-plane services
   * (reverse proxy, platform API) run on this network.
   */
  async ensurePlatformNetwork(options: PlatformNetworkOptions = {}): Promise<string> {
    const existing = await this.findNetwork(PLATFORM_NETWORK_NAME);
    if (existing) {
      const info = await existing.inspect();
      logger.info(`Platform network ${PLATFORM_NETWORK_NAME} already exists`);
      return info.Id;
    }

    const networkOpts: Docker.NetworkCreateOptions = {
      Name: PLATFORM_NETWORK_NAME,
      Driver: "bridge",
      Internal: false,
      Labels: {
        [NETWORK_LABELS.managed]: "true",
        [NETWORK_LABELS.networkType]: "platform",
      },
      Options: {
        "com.docker.network.bridge.enable_icc": "true",
      },
    };

    if (options.subnet) {
      networkOpts.IPAM = {
        Driver: "default",
        Config: [{ Subnet: options.subnet }],
      };
    }

    const network = await this.docker.createNetwork(networkOpts);
    logger.info(`Created platform network ${PLATFORM_NETWORK_NAME} (id: ${network.id})`);
    return network.id;
  }

  /**
   * Connect a container to a tenant's network.
   */
  async connectContainer(tenantId: string, containerId: string): Promise<void> {
    const networkName = TenantNetworkManager.networkNameFor(tenantId);
    const network = await this.findNetwork(networkName);

    if (!network) {
      throw new NetworkNotFoundError(networkName);
    }

    await network.connect({ Container: containerId });
    logger.info(`Connected container ${containerId} to network ${networkName}`);
  }

  /**
   * Disconnect a container from a tenant's network.
   */
  async disconnectContainer(tenantId: string, containerId: string): Promise<void> {
    const networkName = TenantNetworkManager.networkNameFor(tenantId);
    const network = await this.findNetwork(networkName);

    if (!network) {
      logger.warn(`Network ${networkName} not found, cannot disconnect container ${containerId}`);
      return;
    }

    await network.disconnect({ Container: containerId });
    logger.info(`Disconnected container ${containerId} from network ${networkName}`);
  }

  /**
   * Count the number of containers attached to a tenant network.
   */
  async getContainerCount(tenantId: string): Promise<number> {
    const networkName = TenantNetworkManager.networkNameFor(tenantId);
    const network = await this.findNetwork(networkName);

    if (!network) return 0;

    const info = await network.inspect();
    return Object.keys(info.Containers || {}).length;
  }

  // --- Private helpers ---

  private async findNetwork(name: string): Promise<Docker.Network | null> {
    const networks = await this.docker.listNetworks({
      filters: { name: [name] },
    });

    // Docker's name filter is a substring match, so verify exact match
    const match = networks.find((n) => n.Name === name);
    if (!match) return null;

    return this.docker.getNetwork(match.Id);
  }

  private async inspectToTenantNetwork(network: Docker.Network, tenantId: string): Promise<TenantNetwork> {
    const info = await network.inspect();
    return {
      networkId: info.Id,
      tenantId,
      networkName: info.Name,
      containerCount: Object.keys(info.Containers || {}).length,
      createdAt: info.Created || new Date().toISOString(),
    };
  }
}

export class InvalidTenantIdError extends Error {
  constructor(tenantId: string) {
    super(`Invalid tenant ID: "${tenantId}" cannot be used in a Docker network name`);
    this.name = "InvalidTenantIdError";
  }
}

export class NetworkNotFoundError extends Error {
  constructor(networkName: string) {
    super(`Network not found: ${networkName}`);
    this.name = "NetworkNotFoundError";
  }
}

export class NetworkInUseError extends Error {
  readonly containerCount: number;

  constructor(networkName: string, containerCount: number) {
    super(`Network ${networkName} still has ${containerCount} attached container(s)`);
    this.name = "NetworkInUseError";
    this.containerCount = containerCount;
  }
}
