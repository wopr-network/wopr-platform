export type NodeStatus = "active" | "unhealthy" | "offline" | "recovering";

export interface NodeProps {
  id: string;
  host: string;
  status: NodeStatus;
  capacityMb: number;
  usedMb: number;
  agentVersion: string | null;
  lastHeartbeatAt: Date | null;
  registeredAt: Date;
  updatedAt: Date;
}

export class Node {
  private constructor(private readonly props: NodeProps) {}

  get id(): string {
    return this.props.id;
  }

  get host(): string {
    return this.props.host;
  }

  get status(): NodeStatus {
    return this.props.status;
  }

  get capacityMb(): number {
    return this.props.capacityMb;
  }

  get usedMb(): number {
    return this.props.usedMb;
  }

  get availableMb(): number {
    return this.props.capacityMb - this.props.usedMb;
  }

  get agentVersion(): string | null {
    return this.props.agentVersion;
  }

  get lastHeartbeatAt(): Date | null {
    return this.props.lastHeartbeatAt;
  }

  get registeredAt(): Date {
    return this.props.registeredAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  isActive(): boolean {
    return this.props.status === "active";
  }

  isHealthy(): boolean {
    return this.props.status === "active" || this.props.status === "recovering";
  }

  hasCapacity(requiredMb: number): boolean {
    return this.availableMb >= requiredMb;
  }

  static create(props: { id: string; host: string; capacityMb: number; agentVersion?: string }): Node {
    const now = new Date();
    return new Node({
      id: props.id,
      host: props.host,
      status: "active",
      capacityMb: props.capacityMb,
      usedMb: 0,
      agentVersion: props.agentVersion ?? null,
      lastHeartbeatAt: null,
      registeredAt: now,
      updatedAt: now,
    });
  }

  static fromRow(row: {
    id: string;
    host: string;
    status: NodeStatus;
    capacityMb: number;
    usedMb: number;
    agentVersion: string | null;
    lastHeartbeatAt: number | null;
    registeredAt: number;
    updatedAt: number;
  }): Node {
    return new Node({
      id: row.id,
      host: row.host,
      status: row.status,
      capacityMb: row.capacityMb,
      usedMb: row.usedMb,
      agentVersion: row.agentVersion,
      lastHeartbeatAt: row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt * 1000) : null,
      registeredAt: new Date(row.registeredAt * 1000),
      updatedAt: new Date(row.updatedAt * 1000),
    });
  }

  withUpdatedStatus(status: NodeStatus): Node {
    return new Node({
      ...this.props,
      status,
      updatedAt: new Date(),
    });
  }

  withUpdatedCapacity(usedMb: number): Node {
    return new Node({
      ...this.props,
      usedMb,
      updatedAt: new Date(),
    });
  }

  withHeartbeat(agentVersion: string, usedMb: number): Node {
    const now = new Date();
    return new Node({
      ...this.props,
      agentVersion,
      usedMb,
      status: "active",
      lastHeartbeatAt: now,
      updatedAt: now,
    });
  }

  toJSON() {
    return {
      id: this.props.id,
      host: this.props.host,
      status: this.props.status,
      capacityMb: this.props.capacityMb,
      usedMb: this.props.usedMb,
      availableMb: this.availableMb,
      agentVersion: this.props.agentVersion,
      lastHeartbeatAt: this.props.lastHeartbeatAt?.toISOString() ?? null,
      registeredAt: this.props.registeredAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
