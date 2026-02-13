import { z } from "zod";
import { bootstrapNodeSchema, DEFAULT_DHT_PORT } from "../dht/types.js";

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
      const [host, portStr] = addr.split(":");
      return bootstrapNodeSchema.parse({
        host,
        port: portStr ? Number.parseInt(portStr, 10) : DEFAULT_DHT_PORT,
      });
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
});

export type Config = z.infer<typeof configSchema>;
