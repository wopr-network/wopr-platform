export interface IFleetEventRepository {
  fireFleetStop(): void;
  clearFleetStop(): void;
  isFleetStopFired(): boolean;
}
