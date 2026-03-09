export interface FleetEventHistoryFilter {
  botId?: string;
  tenantId?: string;
  type?: string;
  since?: number;
  limit?: number;
}

export interface FleetEventHistoryRow {
  id: number;
  eventType: string;
  botId: string;
  tenantId: string;
  createdAt: number;
}

export interface NewFleetEventHistoryRow {
  eventType: string;
  botId: string;
  tenantId: string;
  createdAt: number;
}

export interface IFleetEventRepository {
  fireFleetStop(): Promise<void>;
  clearFleetStop(): Promise<void>;
  isFleetStopFired(): Promise<boolean>;
  append(event: NewFleetEventHistoryRow): Promise<void>;
  list(filter: FleetEventHistoryFilter): Promise<FleetEventHistoryRow[]>;
}
