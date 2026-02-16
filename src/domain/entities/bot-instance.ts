import { TenantId } from "../value-objects/tenant-id.js";

export type BillingState = "active" | "suspended" | "destroyed";

export interface BotInstanceProps {
  id: string;
  tenantId: TenantId;
  name: string;
  nodeId: string | null;
  billingState: BillingState;
  suspendedAt: Date | null;
  destroyAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class BotInstance {
  private constructor(private readonly props: BotInstanceProps) {}

  get id(): string {
    return this.props.id;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get nodeId(): string | null {
    return this.props.nodeId;
  }

  get billingState(): BillingState {
    return this.props.billingState;
  }

  get suspendedAt(): Date | null {
    return this.props.suspendedAt;
  }

  get destroyAfter(): Date | null {
    return this.props.destroyAfter;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  isActive(): boolean {
    return this.props.billingState === "active";
  }

  isSuspended(): boolean {
    return this.props.billingState === "suspended";
  }

  isDestroyed(): boolean {
    return this.props.billingState === "destroyed";
  }

  static create(props: {
    id: string;
    tenantId: TenantId;
    name: string;
    nodeId?: string | null;
    billingState?: BillingState;
  }): BotInstance {
    const now = new Date();
    return new BotInstance({
      id: props.id,
      tenantId: props.tenantId,
      name: props.name,
      nodeId: props.nodeId ?? null,
      billingState: props.billingState ?? "active",
      suspendedAt: null,
      destroyAfter: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromRow(row: {
    id: string;
    tenantId: string;
    name: string;
    nodeId: string | null;
    billingState: BillingState;
    suspendedAt: string | null;
    destroyAfter: string | null;
    createdAt: string;
    updatedAt: string;
  }): BotInstance {
    return new BotInstance({
      id: row.id,
      tenantId: TenantId.create(row.tenantId),
      name: row.name,
      nodeId: row.nodeId,
      billingState: row.billingState,
      suspendedAt: row.suspendedAt ? new Date(row.suspendedAt) : null,
      destroyAfter: row.destroyAfter ? new Date(row.destroyAfter) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
  }

  suspend(): BotInstance {
    if (this.props.billingState !== "active") {
      throw new Error("Can only suspend active bots");
    }
    const now = new Date();
    const destroyAfter = new Date(now);
    destroyAfter.setDate(destroyAfter.getDate() + 30);

    return new BotInstance({
      ...this.props,
      billingState: "suspended",
      suspendedAt: now,
      destroyAfter,
      updatedAt: now,
    });
  }

  reactivate(): BotInstance {
    if (this.props.billingState !== "suspended") {
      throw new Error("Can only reactivate suspended bots");
    }
    const now = new Date();
    return new BotInstance({
      ...this.props,
      billingState: "active",
      suspendedAt: null,
      destroyAfter: null,
      updatedAt: now,
    });
  }

  destroy(): BotInstance {
    if (this.props.billingState === "destroyed") {
      throw new Error("Bot is already destroyed");
    }
    return new BotInstance({
      ...this.props,
      billingState: "destroyed",
      updatedAt: new Date(),
    });
  }

  toJSON() {
    return {
      id: this.props.id,
      tenantId: this.props.tenantId.toString(),
      name: this.props.name,
      nodeId: this.props.nodeId,
      billingState: this.props.billingState,
      suspendedAt: this.props.suspendedAt?.toISOString() ?? null,
      destroyAfter: this.props.destroyAfter?.toISOString() ?? null,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
