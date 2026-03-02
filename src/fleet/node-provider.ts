/** Provider-agnostic node creation spec */
export interface CreateNodeSpec {
  name: string;
  region: string;
  size: string;
  sshKeyIds: number[];
  tags: string[];
  userData?: string;
}

/** Provider-agnostic node status result */
export interface ProviderNode {
  externalId: string;
  status: "pending" | "active" | "off" | "error";
  publicIp: string | null;
  memoryMb: number;
  monthlyCostCents: number;
}

/** Provider-agnostic region */
export interface ProviderRegion {
  slug: string;
  name: string;
  available: boolean;
}

/** Provider-agnostic size/plan */
export interface ProviderSize {
  slug: string;
  memoryMb: number;
  vcpus: number;
  diskGb: number;
  monthlyCostCents: number;
  available: boolean;
  regions: string[];
  description: string;
}

/** The interface that all cloud providers must implement */
export interface INodeProvider {
  /** Create a node. Returns immediately with externalId (may still be booting). */
  createNode(spec: CreateNodeSpec): Promise<{ externalId: string }>;

  /** Delete a node by its provider-specific external ID. */
  deleteNode(externalId: string): Promise<void>;

  /** Get current status of a node. Used for polling during provisioning. */
  getNodeStatus(externalId: string): Promise<ProviderNode>;

  /** List available regions. */
  listRegions(): Promise<ProviderRegion[]>;

  /** List available sizes/plans. */
  listSizes(): Promise<ProviderSize[]>;
}
