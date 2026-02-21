/**
 * Node lifecycle state machine — pure logic, zero dependencies.
 *
 * This is the single source of truth for valid node status transitions.
 * INodeRepository.transition() enforces this graph; no other code may
 * change node status directly.
 *
 * Key invariant: 'returning' is the ONLY path from dead states back to 'active'.
 * A node that was offline/recovering/failed cannot skip the orphan-cleanup gate.
 */

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

/**
 * Complete transition graph for node lifecycle.
 *
 * ```
 * provisioning → active, failed
 * active       → unhealthy, draining
 * unhealthy    → active, offline
 * offline      → recovering, returning
 * recovering   → offline, returning
 * returning    → active, failed
 * draining     → offline
 * failed       → returning
 * ```
 */
export const VALID_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  provisioning: ["active", "failed"],
  active: ["unhealthy", "draining"],
  unhealthy: ["active", "offline"],
  offline: ["recovering", "returning"],
  recovering: ["offline", "returning"],
  returning: ["active", "failed"],
  draining: ["offline"],
  failed: ["returning"],
};

/** Check whether a transition from one status to another is allowed. */
export function isValidTransition(from: NodeStatus, to: NodeStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Thrown when code attempts a transition not in the valid graph. */
export class InvalidTransitionError extends Error {
  readonly name = "InvalidTransitionError" as const;
  constructor(from: NodeStatus, to: NodeStatus) {
    super(`Invalid node transition: ${from} → ${to}`);
  }
}

/** Thrown when a CAS (compare-and-swap) update finds the status was changed concurrently. */
export class ConcurrentTransitionError extends Error {
  readonly name = "ConcurrentTransitionError" as const;
  constructor(nodeId: string) {
    super(`Concurrent transition conflict on node ${nodeId} — status changed underneath us`);
  }
}

/** Thrown when a transition targets a node ID that does not exist. */
export class NodeNotFoundError extends Error {
  readonly name = "NodeNotFoundError" as const;
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`);
  }
}
