export interface WindowResult {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  creditDeductionFailures: number;
  byCapability: Map<string, { requests: number; errors: number; errorRate: number }>;
}

export interface IMetricsRepository {
  recordGatewayRequest(capability: string): Promise<void>;
  recordGatewayError(capability: string): Promise<void>;
  recordCreditDeductionFailure(): Promise<void>;
  getWindow(minutes: number): Promise<WindowResult>;
  prune(maxRetentionMinutes: number): Promise<number>;
}
