export interface IFleetEventRepository {
  fireFleetStop(): Promise<void>;
  clearFleetStop(): Promise<void>;
  isFleetStopFired(): Promise<boolean>;
}
