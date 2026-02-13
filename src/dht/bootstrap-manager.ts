import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import {
  type BootstrapNode,
  DHT_CONTAINER_PREFIX,
  DHT_LABELS,
  DHT_VOLUME_PREFIX,
  type DhtConfig,
  type DhtNodeStatus,
} from "./types.js";

/**
 * Manages a fleet of private Hyperswarm DHT bootstrap node containers.
 *
 * Each node runs a `@hyperswarm/dht` instance in bootstrap-only mode,
 * listening on a UDP port. State is persisted to a named Docker volume
 * so that node IDs survive restarts.
 *
 * The bootstrap nodes form the private DHT that all WaaS WOPR instances
 * connect to, isolating them from the public Hyperswarm network.
 */
export class DhtBootstrapManager {
  private readonly docker: Docker;
  private readonly config: DhtConfig;

  constructor(docker: Docker, config: DhtConfig) {
    this.docker = docker;
    this.config = config;
  }

  /**
   * Ensure all bootstrap nodes are running. Creates containers that
   * don't exist yet, starts stopped ones. Idempotent.
   */
  async ensureAll(): Promise<DhtNodeStatus[]> {
    const statuses: DhtNodeStatus[] = [];

    for (let i = 0; i < this.config.nodeCount; i++) {
      const status = await this.ensureNode(i);
      statuses.push(status);
    }

    logger.info(`DHT bootstrap: ${statuses.length} node(s) ensured`, {
      running: statuses.filter((s) => s.state === "running").length,
    });

    return statuses;
  }

  /**
   * Ensure a single bootstrap node is running.
   */
  async ensureNode(index: number): Promise<DhtNodeStatus> {
    const containerName = DhtBootstrapManager.containerName(index);
    const volumeName = DhtBootstrapManager.volumeName(index);
    const port = this.config.basePort + index;
    const address = this.externalAddress(index);

    const existing = await this.findContainer(containerName);

    if (existing) {
      const info = await existing.inspect();
      const isRunning = info.State.Running;

      if (!isRunning) {
        await existing.start();
        logger.info(`Started DHT bootstrap node ${index} (${containerName})`);
      }

      return {
        index,
        containerId: info.Id,
        state: "running",
        address,
        volumeName,
      };
    }

    // Ensure volume exists
    await this.ensureVolume(volumeName);

    // Create and start the container
    const container = await this.docker.createContainer({
      Image: this.config.image,
      name: containerName,
      Env: [
        `DHT_PORT=${port}`,
        `DHT_BOOTSTRAP=true`,
        // Pass other bootstrap node addresses so they can find each other
        `DHT_PEERS=${this.peerAddresses(index).join(",")}`,
      ],
      Labels: {
        [DHT_LABELS.managed]: "true",
        [DHT_LABELS.nodeIndex]: String(index),
      },
      ExposedPorts: {
        [`${port}/udp`]: {},
      },
      HostConfig: {
        Binds: [`${volumeName}:/data`],
        PortBindings: {
          [`${port}/udp`]: [{ HostPort: String(port) }],
        },
        RestartPolicy: { Name: "unless-stopped" },
      },
    });

    await container.start();
    logger.info(`Created and started DHT bootstrap node ${index} (${container.id})`, {
      port,
      volumeName,
    });

    return {
      index,
      containerId: container.id,
      state: "running",
      address,
      volumeName,
    };
  }

  /**
   * Stop and remove all bootstrap node containers. Does NOT remove volumes
   * (persistent state is retained for restarts).
   */
  async removeAll(): Promise<void> {
    for (let i = 0; i < this.config.nodeCount; i++) {
      await this.removeNode(i);
    }
    logger.info("DHT bootstrap: all nodes removed");
  }

  /**
   * Stop and remove a single bootstrap node container.
   */
  async removeNode(index: number): Promise<void> {
    const containerName = DhtBootstrapManager.containerName(index);
    const existing = await this.findContainer(containerName);

    if (!existing) {
      logger.info(`DHT bootstrap node ${index} not found, nothing to remove`);
      return;
    }

    const info = await existing.inspect();
    if (info.State.Running) {
      await existing.stop();
    }
    await existing.remove();
    logger.info(`Removed DHT bootstrap node ${index} (${containerName})`);
  }

  /**
   * Get status of all bootstrap nodes.
   */
  async statusAll(): Promise<DhtNodeStatus[]> {
    const statuses: DhtNodeStatus[] = [];
    for (let i = 0; i < this.config.nodeCount; i++) {
      statuses.push(await this.statusNode(i));
    }
    return statuses;
  }

  /**
   * Get status of a single bootstrap node.
   */
  async statusNode(index: number): Promise<DhtNodeStatus> {
    const containerName = DhtBootstrapManager.containerName(index);
    const volumeName = DhtBootstrapManager.volumeName(index);
    const address = this.externalAddress(index);

    const existing = await this.findContainer(containerName);

    if (!existing) {
      return { index, containerId: null, state: "not_found", address, volumeName };
    }

    const info = await existing.inspect();
    return {
      index,
      containerId: info.Id,
      state: info.State.Running ? "running" : "stopped",
      address,
      volumeName,
    };
  }

  /**
   * Returns the list of bootstrap addresses that WOPR instances should use
   * in their `p2p.bootstrap` config.
   *
   * If external addresses are configured, those are used. Otherwise,
   * addresses are derived from the base port.
   */
  getBootstrapAddresses(): BootstrapNode[] {
    if (this.config.externalAddresses.length > 0) {
      return this.config.externalAddresses;
    }

    const addresses: BootstrapNode[] = [];
    for (let i = 0; i < this.config.nodeCount; i++) {
      addresses.push(this.externalAddress(i));
    }
    return addresses;
  }

  // --- Static helpers ---

  static containerName(index: number): string {
    return `${DHT_CONTAINER_PREFIX}${index}`;
  }

  static volumeName(index: number): string {
    return `${DHT_VOLUME_PREFIX}${index}`;
  }

  // --- Private helpers ---

  private externalAddress(index: number): BootstrapNode {
    if (this.config.externalAddresses[index]) {
      return this.config.externalAddresses[index];
    }
    return { host: DhtBootstrapManager.containerName(index), port: this.config.basePort + index };
  }

  /**
   * Returns peer addresses for a given node (all other bootstrap nodes).
   * Used so bootstrap nodes can find each other.
   */
  private peerAddresses(excludeIndex: number): string[] {
    const peers: string[] = [];
    for (let i = 0; i < this.config.nodeCount; i++) {
      if (i !== excludeIndex) {
        const addr = this.externalAddress(i);
        peers.push(`${addr.host}:${addr.port}`);
      }
    }
    return peers;
  }

  private async findContainer(name: string): Promise<Docker.Container | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { name: [name] },
    });

    // Docker name filter is a substring match; verify exact match.
    // Container names from Docker API include a leading slash.
    const match = containers.find((c) => c.Names?.some((n) => n === `/${name}` || n === name));
    if (!match) return null;

    return this.docker.getContainer(match.Id);
  }

  private async ensureVolume(name: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(name);
      await volume.inspect();
    } catch (_inspectErr: unknown) {
      try {
        await this.docker.createVolume({ Name: name });
        logger.info(`Created DHT state volume ${name}`);
      } catch (createErr: unknown) {
        logger.error(`Failed to create DHT state volume ${name}`, { error: createErr });
        throw createErr;
      }
    }
  }
}
