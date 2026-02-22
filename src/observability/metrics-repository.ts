export interface WindowResult {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  creditDeductionFailures: number;
  byCapability: Map<string, { requests: number; errors: number; errorRate: number }>;
}

export interface IMetricsRepository {
  recordGatewayRequest(capability: string): void;
  recordGatewayError(capability: string): void;
  recordCreditDeductionFailure(): void;
  getWindow(minutes: number): WindowResult;
  prune(maxRetentionMinutes: number): number;
}
