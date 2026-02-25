// src/fleet/repository-types.ts
//
// Plain TypeScript interfaces for all fleet domain objects.
// No Drizzle types. No better-sqlite3. These are the contract
// the fleet layer works against.

import type { NodeStatus } from "./node-state-machine.js";

// Re-export for convenience — consumers import from here
export type { NodeStatus };

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

/** Plain domain object representing a node — mirrors `nodes` table columns. */
export interface Node {
  id: string;
  host: string;
  status: NodeStatus;
  capacityMb: number;
  usedMb: number;
  agentVersion: string | null;
  lastHeartbeatAt: number | null;
  registeredAt: number;
  updatedAt: number;
  dropletId: string | null;
  region: string | null;
  size: string | null;
  monthlyCostCents: number | null;
  provisionStage: string | null;
  lastError: string | null;
  drainStatus: string | null;
  drainMigrated: number | null;
  drainTotal: number | null;
  ownerUserId: string | null;
  nodeSecret: string | null;
  label: string | null;
}

// ---------------------------------------------------------------------------
// NodeTransition
// ---------------------------------------------------------------------------

// node_transitions table is created by WOP-859 (src/db/schema/node-transitions.ts)
/** Audit record for a single node status transition — mirrors `node_transitions` table. */
export interface NodeTransition {
  id: string;
  nodeId: string;
  fromStatus: NodeStatus;
  toStatus: NodeStatus;
  reason: string;
  triggeredBy: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// NodeRegistration
// ---------------------------------------------------------------------------

/** Payload for registering (or re-registering) a node. */
export interface NodeRegistration {
  nodeId: string;
  host: string;
  capacityMb: number;
  agentVersion: string;
}

/** Payload for registering a new self-hosted node with persistent secret. */
export interface SelfHostedNodeRegistration extends NodeRegistration {
  ownerUserId: string;
  label: string | null;
  nodeSecretHash: string;
}

// ---------------------------------------------------------------------------
// BotInstance
// ---------------------------------------------------------------------------

/** Billing lifecycle states for a bot instance. */
export type BillingState = "active" | "suspended" | "destroyed";

/** Plain domain object for a bot instance — mirrors `bot_instances` table. */
export interface BotInstance {
  id: string;
  tenantId: string;
  name: string;
  nodeId: string | null;
  billingState: BillingState;
  suspendedAt: string | null;
  destroyAfter: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
}

/** Create payload for a new bot instance. */
export interface NewBotInstance {
  id: string;
  tenantId: string;
  name: string;
  nodeId: string | null;
  billingState?: BillingState;
  createdByUserId?: string | null;
}

// ---------------------------------------------------------------------------
// RecoveryEvent
// ---------------------------------------------------------------------------

/** Status of a recovery event. */
export type RecoveryEventStatus = "in_progress" | "completed" | "partial";

/** Plain domain object for a recovery event — mirrors `recovery_events` table. */
export interface RecoveryEvent {
  id: string;
  nodeId: string;
  trigger: string;
  status: RecoveryEventStatus;
  tenantsTotal: number | null;
  tenantsRecovered: number | null;
  tenantsFailed: number | null;
  tenantsWaiting: number | null;
  startedAt: number;
  completedAt: number | null;
  reportJson: string | null;
}

/** Create payload for a new recovery event. */
export interface NewRecoveryEvent {
  id: string;
  nodeId: string;
  trigger: string;
  tenantsTotal: number;
}

// ---------------------------------------------------------------------------
// RecoveryItem
// ---------------------------------------------------------------------------

/** Status of a per-tenant recovery item. */
export type RecoveryItemStatus = "recovered" | "failed" | "skipped" | "retried" | "waiting";

/** Plain domain object for a per-tenant recovery item — mirrors `recovery_items` table. */
export interface RecoveryItem {
  id: string;
  recoveryEventId: string;
  tenant: string;
  sourceNode: string;
  targetNode: string | null;
  backupKey: string | null;
  status: RecoveryItemStatus;
  reason: string | null;
  retryCount: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** Create payload for a new recovery item. */
export interface NewRecoveryItem {
  id: string;
  recoveryEventId: string;
  tenant: string;
  sourceNode: string;
  backupKey: string | null;
}

// ---------------------------------------------------------------------------
// GpuNode
// ---------------------------------------------------------------------------

/** Lifecycle states for a GPU compute node. */
export type GpuNodeStatus = "provisioning" | "bootstrapping" | "active" | "degraded" | "failed" | "destroying";

/** Plain domain object representing a GPU node — mirrors `gpu_nodes` table columns. */
export interface GpuNode {
  id: string;
  dropletId: string | null;
  host: string | null;
  region: string;
  size: string;
  status: GpuNodeStatus;
  provisionStage: string;
  serviceHealth: Record<string, "ok" | "down"> | null;
  monthlyCostCents: number | null;
  lastHealthAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Create payload for a new GPU node. */
export interface NewGpuNode {
  id: string;
  region: string;
  size: string;
}

// ---------------------------------------------------------------------------
// FleetEvent
// ---------------------------------------------------------------------------

export type FleetEventType = "unexpected_stop";

export interface FleetEvent {
  id: number;
  eventType: FleetEventType;
  fired: boolean;
  createdAt: number;
  clearedAt: number | null;
}

// ---------------------------------------------------------------------------
// VPS Subscription
// ---------------------------------------------------------------------------

export type VpsStatus = "active" | "canceling" | "canceled";

export interface VpsSubscription {
  botId: string;
  tenantId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  status: VpsStatus;
  sshPublicKey: string | null;
  cloudflareTunnelId: string | null;
  hostname: string | null;
  diskSizeGb: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewVpsSubscription {
  botId: string;
  tenantId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  hostname?: string | null;
  diskSizeGb?: number;
}
