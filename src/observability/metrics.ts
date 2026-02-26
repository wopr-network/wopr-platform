import type { IMetricsRepository, WindowResult } from "./metrics-repository.js";

export type { WindowResult } from "./metrics-repository.js";

export class MetricsCollector {
  private readonly repo: IMetricsRepository;

  constructor(repo: IMetricsRepository) {
    this.repo = repo;
  }

  recordGatewayRequest(capability: string): void {
    this.repo.recordGatewayRequest(capability);
  }

  recordGatewayError(capability: string): void {
    this.repo.recordGatewayError(capability);
  }

  recordCreditDeductionFailure(): void {
    this.repo.recordCreditDeductionFailure();
  }

  /** Aggregate metrics across the last N minutes. */
  async getWindow(minutes: number): Promise<WindowResult> {
    return this.repo.getWindow(minutes);
  }
}
