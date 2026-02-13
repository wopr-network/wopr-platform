import { z } from "zod";
import { bootstrapNodeSchema, DEFAULT_DHT_PORT } from "../dht/types.js";
import { DEFAULT_DISCOVERY_TOPIC } from "../discovery/types.js";

/**
 * Parse a comma-separated list of host:port addresses into BootstrapNode[].
 * Example: "dht1.wopr.io:49737,dht2.wopr.io:49737"
 */
function parseBootstrapAddresses(raw: string | undefined) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((addr) => {
      const parts = addr.split(":");
      const host = parts[0];
      const portStr = parts[1];
      const port = portStr ? Number.parseInt(portStr, 10) : DEFAULT_DHT_PORT;

      if (!host) {
        throw new Error(`Invalid DHT_BOOTSTRAP_ADDRESSES entry "${addr}": missing host`);
      }
      if (Number.isNaN(port)) {
        throw new Error(`Invalid DHT_BOOTSTRAP_ADDRESSES entry "${addr}": port is not a number`);
      }

      return bootstrapNodeSchema.parse({ host, port });
    });
}

const configSchema = z.object({
  port: z.coerce.number().default(3100),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),

  /** DHT bootstrap configuration. */
  dht: z
    .object({
      nodeCount: z.coerce.number().int().min(1).max(5).default(3),
      basePort: z.coerce.number().int().min(1).max(65535).default(DEFAULT_DHT_PORT),
      image: z.string().default("wopr-dht-bootstrap:latest"),
      externalAddresses: z.array(bootstrapNodeSchema).default([]),
    })
    .default({
      nodeCount: 3,
      basePort: DEFAULT_DHT_PORT,
      image: "wopr-dht-bootstrap:latest",
      externalAddresses: [],
    }),

  /** P2P discovery configuration. */
  discovery: z
    .object({
      /** The default global discovery topic all instances join. */
      defaultTopic: z.string().min(1).default(DEFAULT_DISCOVERY_TOPIC),
    })
    .default({
      defaultTopic: DEFAULT_DISCOVERY_TOPIC,
    }),
});

export const config = configSchema.parse({
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  logLevel: process.env.LOG_LEVEL,
  dht: {
    nodeCount: process.env.DHT_NODE_COUNT,
    basePort: process.env.DHT_BASE_PORT,
    image: process.env.DHT_IMAGE,
    externalAddresses: parseBootstrapAddresses(process.env.DHT_BOOTSTRAP_ADDRESSES),
  },
  discovery: {
    defaultTopic: process.env.DISCOVERY_DEFAULT_TOPIC,
  },
});

export type Config = z.infer<typeof configSchema>;
