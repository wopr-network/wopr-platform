export interface GatewayMetricRow {
  minuteKey: number;
  capability: string;
  requests: number;
  errors: number;
  creditFailures: number;
}
