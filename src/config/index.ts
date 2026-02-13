import { z } from "zod/v4";

const configSchema = z.object({
  port: z.coerce.number().default(3100),
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

export const config = configSchema.parse({
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  logLevel: process.env.LOG_LEVEL,
});

export type Config = z.infer<typeof configSchema>;
