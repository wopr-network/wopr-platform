/** Name prefix for tenant-isolated Docker networks. */
export const TENANT_NETWORK_PREFIX = "wopr-tenant-";

/** Name for the platform management network. */
export const PLATFORM_NETWORK_NAME = "wopr-platform-mgmt";

/** Docker labels applied to managed networks. */
export const NETWORK_LABELS = {
  managed: "wopr.managed-network",
  tenantId: "wopr.tenant-id",
  networkType: "wopr.network-type",
} as const;

/** Types of managed networks. */
export type NetworkType = "tenant" | "platform";

/** Represents a tenant-scoped Docker network. */
export interface TenantNetwork {
  /** Docker network ID */
  networkId: string;
  /** User/tenant identifier */
  tenantId: string;
  /** Full Docker network name (e.g. wopr-tenant-<userId>) */
  networkName: string;
  /** Number of containers currently attached */
  containerCount: number;
  /** ISO timestamp of creation */
  createdAt: string;
}

/** Options for creating a tenant network. */
export interface CreateTenantNetworkOptions {
  /** User/tenant identifier */
  tenantId: string;
  /** Enable inter-container communication within the network (default: true for P2P) */
  enableIcc?: boolean;
  /** Custom subnet (optional — Docker assigns one if omitted) */
  subnet?: string;
}

/** Options for the platform management network. */
export interface PlatformNetworkOptions {
  /** Custom subnet for the management network */
  subnet?: string;
}
