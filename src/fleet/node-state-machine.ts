// src/fleet/node-state-machine.ts (minimal stub — Task 4 fills this in fully)
export const NODE_STATUSES = [
  "provisioning",
  "active",
  "unhealthy",
  "offline",
  "recovering",
  "returning",
  "draining",
  "failed",
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];
