import { TenantId } from "../value-objects/tenant-id.js";

export type TenantAccountStatus = "active" | "grace_period" | "suspended" | "banned";

export interface TenantStatusProps {
  tenantId: TenantId;
  status: TenantAccountStatus;
  statusReason: string | null;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
  graceDeadline: Date | null;
  dataDeleteAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class TenantStatus {
  private constructor(private readonly props: TenantStatusProps) {}

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get status(): TenantAccountStatus {
    return this.props.status;
  }

  get statusReason(): string | null {
    return this.props.statusReason;
  }

  get statusChangedAt(): Date | null {
    return this.props.statusChangedAt;
  }

  get statusChangedBy(): string | null {
    return this.props.statusChangedBy;
  }

  get graceDeadline(): Date | null {
    return this.props.graceDeadline;
  }

  get dataDeleteAfter(): Date | null {
    return this.props.dataDeleteAfter;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  isOperational(): boolean {
    return this.props.status === "active" || this.props.status === "grace_period";
  }

  static createDefault(tenantId: TenantId): TenantStatus {
    const now = new Date();
    return new TenantStatus({
      tenantId,
      status: "active",
      statusReason: null,
      statusChangedAt: null,
      statusChangedBy: null,
      graceDeadline: null,
      dataDeleteAfter: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromRow(row: {
    tenantId: string;
    status: TenantAccountStatus;
    statusReason: string | null;
    statusChangedAt: number | null;
    statusChangedBy: string | null;
    graceDeadline: string | null;
    dataDeleteAfter: string | null;
    createdAt: number;
    updatedAt: number;
  }): TenantStatus {
    return new TenantStatus({
      tenantId: TenantId.create(row.tenantId),
      status: row.status,
      statusReason: row.statusReason,
      statusChangedAt: row.statusChangedAt ? new Date(row.statusChangedAt) : null,
      statusChangedBy: row.statusChangedBy,
      graceDeadline: row.graceDeadline ? new Date(row.graceDeadline) : null,
      dataDeleteAfter: row.dataDeleteAfter ? new Date(row.dataDeleteAfter) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
  }

  toJSON() {
    return {
      tenantId: this.props.tenantId.toString(),
      status: this.props.status,
      statusReason: this.props.statusReason,
      statusChangedAt: this.props.statusChangedAt?.toISOString() ?? null,
      statusChangedBy: this.props.statusChangedBy,
      graceDeadline: this.props.graceDeadline?.toISOString() ?? null,
      dataDeleteAfter: this.props.dataDeleteAfter?.toISOString() ?? null,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
