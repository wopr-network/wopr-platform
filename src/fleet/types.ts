import { z } from "zod";

/** Schema for a bot instance managed by the fleet */
export const botInstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  status: z.enum(["running", "stopped", "error", "pulling"]),
  containerId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type BotInstance = z.infer<typeof botInstanceSchema>;

/** Schema for a bot profile template */
export const botProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  image: z.string(),
  env: z.record(z.string(), z.string()).default({}),
});

export type BotProfile = z.infer<typeof botProfileSchema>;
