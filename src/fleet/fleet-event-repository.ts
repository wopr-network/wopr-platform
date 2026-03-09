import type { FleetEventHistoryFilter, FleetEventHistoryRow, NewFleetEventHistoryRow } from "./repository-types.js";

export type {
  FleetEventHistoryFilter,
  FleetEventHistoryRow,
  NewFleetEventHistoryRow,
} from "./repository-types.js";

export interface IFleetEventRepository {
  fireFleetStop(): Promise<void>;
  clearFleetStop(): Promise<void>;
  isFleetStopFired(): Promise<boolean>;
  append(event: NewFleetEventHistoryRow): Promise<void>;
  list(filter: FleetEventHistoryFilter): Promise<FleetEventHistoryRow[]>;
}
