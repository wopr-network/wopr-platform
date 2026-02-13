import { z } from "zod";

/** Default DHT port used by Hyperswarm bootstrap nodes. */
export const DEFAULT_DHT_PORT = 49737;

/** Docker label namespace for DHT bootstrap containers. */
export const DHT_LABELS = {
  managed: "wopr.dht-bootstrap",
  nodeIndex: "wopr.dht-node-index",
} as const;

/** Container name prefix for DHT bootstrap nodes. */
export const DHT_CONTAINER_PREFIX = "wopr-dht-bootstrap-";

/** Docker volume prefix for DHT bootstrap persistent state. */
export const DHT_VOLUME_PREFIX = "wopr-dht-state-";

/** A single DHT bootstrap node address (host:port). */
export const bootstrapNodeSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_DHT_PORT),
});

export type BootstrapNode = z.infer<typeof bootstrapNodeSchema>;

/** Platform-level DHT configuration. */
export const dhtConfigSchema = z.object({
  /** Number of bootstrap nodes to run (2-5). */
  nodeCount: z.coerce.number().int().min(1).max(5).default(3),
  /** Base port for the first node. Subsequent nodes use port+1, port+2, etc. */
  basePort: z.coerce.number().int().min(1).max(65535).default(DEFAULT_DHT_PORT),
  /** Docker image for the DHT bootstrap node. */
  image: z.string().default("wopr-dht-bootstrap:latest"),
  /**
   * Externally-reachable bootstrap addresses for WOPR instances.
   * If empty, derived from the container name and base port offset.
   */
  externalAddresses: z.array(bootstrapNodeSchema).default([]),
});

export type DhtConfig = z.infer<typeof dhtConfigSchema>;

/** Status of a single DHT bootstrap node container. */
export interface DhtNodeStatus {
  /** Node index (0-based). */
  index: number;
  /** Docker container ID (null if not found). */
  containerId: string | null;
  /** Container state. */
  state: "running" | "stopped" | "not_found";
  /** The host:port this node listens on. */
  address: BootstrapNode;
  /** Docker volume name for persistent state. */
  volumeName: string;
}
