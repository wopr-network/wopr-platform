/** Maximum number of minutes of data to retain. */
const MAX_RETENTION_MINUTES = 120;

interface MetricsBucket {
  timestamp: number; // minute-aligned epoch ms
  gatewayRequests: Map<string, number>;
  gatewayErrors: Map<string, number>;
  creditDeductionFailures: number;
}

export interface WindowResult {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  creditDeductionFailures: number;
  byCapability: Map<string, { requests: number; errors: number; errorRate: number }>;
}

export class MetricsCollector {
  private buckets: Map<number, MetricsBucket> = new Map();

  /** Get or create the bucket for the current minute. */
  private currentBucket(): MetricsBucket {
    const now = Date.now();
    const minuteKey = now - (now % 60_000);

    let bucket = this.buckets.get(minuteKey);
    if (!bucket) {
      this.prune();
      bucket = {
        timestamp: minuteKey,
        gatewayRequests: new Map(),
        gatewayErrors: new Map(),
        creditDeductionFailures: 0,
      };
      this.buckets.set(minuteKey, bucket);
    }
    return bucket;
  }

  /** Remove buckets older than MAX_RETENTION_MINUTES. */
  private prune(): void {
    const cutoff = Date.now() - MAX_RETENTION_MINUTES * 60_000;
    for (const [key] of this.buckets) {
      if (key < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  recordGatewayRequest(capability: string): void {
    const bucket = this.currentBucket();
    bucket.gatewayRequests.set(capability, (bucket.gatewayRequests.get(capability) ?? 0) + 1);
  }

  recordGatewayError(capability: string): void {
    const bucket = this.currentBucket();
    bucket.gatewayErrors.set(capability, (bucket.gatewayErrors.get(capability) ?? 0) + 1);
  }

  recordCreditDeductionFailure(): void {
    const bucket = this.currentBucket();
    bucket.creditDeductionFailures++;
  }

  /** Aggregate metrics across the last N minutes. */
  getWindow(minutes: number): WindowResult {
    const cutoff = Date.now() - minutes * 60_000;
    const byCapability = new Map<string, { requests: number; errors: number }>();
    let totalRequests = 0;
    let totalErrors = 0;
    let creditDeductionFailures = 0;

    for (const [, bucket] of this.buckets) {
      if (bucket.timestamp < cutoff) continue;

      for (const [cap, count] of bucket.gatewayRequests) {
        const existing = byCapability.get(cap) ?? { requests: 0, errors: 0 };
        existing.requests += count;
        byCapability.set(cap, existing);
        totalRequests += count;
      }

      for (const [cap, count] of bucket.gatewayErrors) {
        const existing = byCapability.get(cap) ?? { requests: 0, errors: 0 };
        existing.errors += count;
        byCapability.set(cap, existing);
        totalErrors += count;
      }

      creditDeductionFailures += bucket.creditDeductionFailures;
    }

    const resultByCapability = new Map<string, { requests: number; errors: number; errorRate: number }>();
    for (const [cap, data] of byCapability) {
      resultByCapability.set(cap, {
        ...data,
        errorRate: data.requests > 0 ? data.errors / data.requests : 0,
      });
    }

    return {
      totalRequests,
      totalErrors,
      errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
      creditDeductionFailures,
      byCapability: resultByCapability,
    };
  }
}
