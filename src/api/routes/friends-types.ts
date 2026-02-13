import { z } from "zod";

/** Allowlist: only alphanumeric, hyphens, and underscores. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const instanceIdSchema = z.string().regex(SAFE_ID_RE, "Invalid instance ID");

/** Friend capability levels. */
export const friendCapabilitySchema = z.enum(["message-only", "inject", "ai-access"]);
export type FriendCapability = z.infer<typeof friendCapabilitySchema>;

/** Schema for updating a friend's capabilities. */
export const updateCapabilitiesSchema = z.object({
  capabilities: z.array(friendCapabilitySchema).min(1, "At least one capability required"),
});

/** Schema for sending a friend request. */
export const sendFriendRequestSchema = z.object({
  /** The peer ID or discovery ID of the target bot. */
  peerId: z.string().min(1, "peerId is required"),
  /** Optional message to send with the request. */
  message: z.string().max(256).optional(),
});

/** Schema for auto-accept rule configuration. */
export const autoAcceptRuleSchema = z.object({
  /** Whether auto-accept is enabled. */
  enabled: z.boolean(),
  /** Only auto-accept from peers on the same discovery topic. */
  sameTopicOnly: z.boolean().default(false),
  /** Default capabilities granted to auto-accepted friends. */
  defaultCapabilities: z.array(friendCapabilitySchema).default(["message-only"]),
  /** Allowlist of peer IDs that are always accepted. Empty = accept all (when enabled). */
  allowlist: z.array(z.string().min(1)).default([]),
});

export type AutoAcceptRule = z.infer<typeof autoAcceptRuleSchema>;
