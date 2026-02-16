export type RecoveryEventStatus = "in_progress" | "completed" | "partial";
export type RecoveryTrigger = "heartbeat_timeout" | "manual";

export interface RecoveryEventProps {
  id: string;
  nodeId: string;
  trigger: RecoveryTrigger;
  status: RecoveryEventStatus;
  tenantsTotal: number | null;
  tenantsRecovered: number | null;
  tenantsFailed: number | null;
  tenantsWaiting: number | null;
  startedAt: Date;
  completedAt: Date | null;
  reportJson: string | null;
}

export class RecoveryEvent {
  private constructor(private readonly props: RecoveryEventProps) {}

  get id(): string {
    return this.props.id;
  }

  get nodeId(): string {
    return this.props.nodeId;
  }

  get trigger(): RecoveryTrigger {
    return this.props.trigger;
  }

  get status(): RecoveryEventStatus {
    return this.props.status;
  }

  get tenantsTotal(): number | null {
    return this.props.tenantsTotal;
  }

  get tenantsRecovered(): number | null {
    return this.props.tenantsRecovered;
  }

  get tenantsFailed(): number | null {
    return this.props.tenantsFailed;
  }

  get tenantsWaiting(): number | null {
    return this.props.tenantsWaiting;
  }

  get startedAt(): Date {
    return this.props.startedAt;
  }

  get completedAt(): Date | null {
    return this.props.completedAt;
  }

  get reportJson(): string | null {
    return this.props.reportJson;
  }

  isCompleted(): boolean {
    return this.props.status === "completed";
  }

  isPartial(): boolean {
    return this.props.status === "partial";
  }

  static create(props: { id: string; nodeId: string; trigger: RecoveryTrigger }): RecoveryEvent {
    return new RecoveryEvent({
      id: props.id,
      nodeId: props.nodeId,
      trigger: props.trigger,
      status: "in_progress",
      tenantsTotal: null,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 0,
      startedAt: new Date(),
      completedAt: null,
      reportJson: null,
    });
  }

  static fromRow(row: {
    id: string;
    nodeId: string;
    trigger: RecoveryTrigger;
    status: RecoveryEventStatus;
    tenantsTotal: number | null;
    tenantsRecovered: number | null;
    tenantsFailed: number | null;
    tenantsWaiting: number | null;
    startedAt: number;
    completedAt: number | null;
    reportJson: string | null;
  }): RecoveryEvent {
    return new RecoveryEvent({
      id: row.id,
      nodeId: row.nodeId,
      trigger: row.trigger,
      status: row.status,
      tenantsTotal: row.tenantsTotal,
      tenantsRecovered: row.tenantsRecovered,
      tenantsFailed: row.tenantsFailed,
      tenantsWaiting: row.tenantsWaiting,
      startedAt: new Date(row.startedAt * 1000),
      completedAt: row.completedAt ? new Date(row.completedAt * 1000) : null,
      reportJson: row.reportJson,
    });
  }

  complete(props: {
    status: RecoveryEventStatus;
    tenantsRecovered: number;
    tenantsFailed: number;
    tenantsWaiting: number;
    reportJson: string;
  }): RecoveryEvent {
    return new RecoveryEvent({
      ...this.props,
      status: props.status,
      tenantsRecovered: props.tenantsRecovered,
      tenantsFailed: props.tenantsFailed,
      tenantsWaiting: props.tenantsWaiting,
      completedAt: new Date(),
      reportJson: props.reportJson,
    });
  }

  toJSON() {
    return {
      id: this.props.id,
      nodeId: this.props.nodeId,
      trigger: this.props.trigger,
      status: this.props.status,
      tenantsTotal: this.props.tenantsTotal,
      tenantsRecovered: this.props.tenantsRecovered,
      tenantsFailed: this.props.tenantsFailed,
      tenantsWaiting: this.props.tenantsWaiting,
      startedAt: this.props.startedAt.toISOString(),
      completedAt: this.props.completedAt?.toISOString() ?? null,
      reportJson: this.props.reportJson,
    };
  }
}

export type RecoveryItemStatus = "recovered" | "failed" | "skipped" | "waiting" | "retried";

export interface RecoveryItemProps {
  id: string;
  recoveryEventId: string;
  tenant: string;
  sourceNode: string;
  targetNode: string | null;
  backupKey: string | null;
  status: RecoveryItemStatus;
  reason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export class RecoveryItem {
  private constructor(private readonly props: RecoveryItemProps) {}

  get id(): string {
    return this.props.id;
  }

  get recoveryEventId(): string {
    return this.props.recoveryEventId;
  }

  get tenant(): string {
    return this.props.tenant;
  }

  get sourceNode(): string {
    return this.props.sourceNode;
  }

  get targetNode(): string | null {
    return this.props.targetNode;
  }

  get backupKey(): string | null {
    return this.props.backupKey;
  }

  get status(): RecoveryItemStatus {
    return this.props.status;
  }

  get reason(): string | null {
    return this.props.reason;
  }

  get startedAt(): Date | null {
    return this.props.startedAt;
  }

  get completedAt(): Date | null {
    return this.props.completedAt;
  }

  isRecovered(): boolean {
    return this.props.status === "recovered";
  }

  isWaiting(): boolean {
    return this.props.status === "waiting";
  }

  static create(props: {
    id: string;
    recoveryEventId: string;
    tenant: string;
    sourceNode: string;
    targetNode?: string | null;
    backupKey?: string | null;
    status: RecoveryItemStatus;
    reason?: string | null;
  }): RecoveryItem {
    const now = new Date();
    return new RecoveryItem({
      id: props.id,
      recoveryEventId: props.recoveryEventId,
      tenant: props.tenant,
      sourceNode: props.sourceNode,
      targetNode: props.targetNode ?? null,
      backupKey: props.backupKey ?? null,
      status: props.status,
      reason: props.reason ?? null,
      startedAt: now,
      completedAt: props.status === "waiting" ? null : now,
    });
  }

  static fromRow(row: {
    id: string;
    recoveryEventId: string;
    tenant: string;
    sourceNode: string;
    targetNode: string | null;
    backupKey: string | null;
    status: RecoveryItemStatus;
    reason: string | null;
    startedAt: number | null;
    completedAt: number | null;
  }): RecoveryItem {
    return new RecoveryItem({
      id: row.id,
      recoveryEventId: row.recoveryEventId,
      tenant: row.tenant,
      sourceNode: row.sourceNode,
      targetNode: row.targetNode,
      backupKey: row.backupKey,
      status: row.status,
      reason: row.reason,
      startedAt: row.startedAt ? new Date(row.startedAt * 1000) : null,
      completedAt: row.completedAt ? new Date(row.completedAt * 1000) : null,
    });
  }

  complete(targetNode: string): RecoveryItem {
    return new RecoveryItem({
      ...this.props,
      targetNode,
      status: "recovered",
      completedAt: new Date(),
    });
  }

  fail(reason: string): RecoveryItem {
    return new RecoveryItem({
      ...this.props,
      status: "failed",
      reason,
      completedAt: new Date(),
    });
  }

  toJSON() {
    return {
      id: this.props.id,
      recoveryEventId: this.props.recoveryEventId,
      tenant: this.props.tenant,
      sourceNode: this.props.sourceNode,
      targetNode: this.props.targetNode,
      backupKey: this.props.backupKey,
      status: this.props.status,
      reason: this.props.reason,
      startedAt: this.props.startedAt?.toISOString() ?? null,
      completedAt: this.props.completedAt?.toISOString() ?? null,
    };
  }
}
