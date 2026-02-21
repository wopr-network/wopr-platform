/**
 * In-memory sliding-window metrics collector for observability alerts.
 *
 * Tracks counters in 1-minute buckets over a configurable window.
 * Used by the alerting system and the /admin/health dashboard.
 */
export interface MetricsBucket {
  timestamp: number; // minute-aligned unix epoch ms
  gatewayRequests: number;
  gatewayErrors: number;
  creditDeductionFailures: number;
  /** Per-capability error counts: { "llm": 3, "tts": 1 } */
  capabilityErrors: Record<string, number>;
  /** Per-capability request counts */
  capabilityRequests: Record<string, number>;
}

const BUCKET_DURATION_MS = 60_000; // 1 minute
const DEFAULT_WINDOW_MINUTES = 60; // keep 60 minutes of history

export class MetricsCollector {
  private buckets: MetricsBucket[] = [];
  private readonly windowMinutes: number;

  constructor(windowMinutes = DEFAULT_WINDOW_MINUTES) {
    this.windowMinutes = windowMinutes;
  }

  private currentBucket(): MetricsBucket {
    const now = Math.floor(Date.now() / BUCKET_DURATION_MS) * BUCKET_DURATION_MS;
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.timestamp === now) return last;

    const bucket: MetricsBucket = {
      timestamp: now,
      gatewayRequests: 0,
      gatewayErrors: 0,
      creditDeductionFailures: 0,
      capabilityErrors: {},
      capabilityRequests: {},
    };
    this.buckets.push(bucket);
    this.prune();
    return bucket;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMinutes * BUCKET_DURATION_MS;
    while (this.buckets.length > 0 && this.buckets[0].timestamp < cutoff) {
      this.buckets.shift();
    }
  }

  recordGatewayRequest(capability?: string): void {
    const b = this.currentBucket();
    b.gatewayRequests++;
    if (capability) {
      b.capabilityRequests[capability] = (b.capabilityRequests[capability] ?? 0) + 1;
    }
  }

  recordGatewayError(capability?: string): void {
    const b = this.currentBucket();
    b.gatewayErrors++;
    if (capability) {
      b.capabilityErrors[capability] = (b.capabilityErrors[capability] ?? 0) + 1;
    }
  }

  recordCreditDeductionFailure(): void {
    this.currentBucket().creditDeductionFailures++;
  }

  /**
   * Get aggregate stats over the last N minutes.
   */
  getWindow(minutes: number): {
    totalRequests: number;
    totalErrors: number;
    errorRate: number;
    creditDeductionFailures: number;
    capabilityErrorRates: Record<string, number>;
  } {
    const cutoff = Date.now() - minutes * BUCKET_DURATION_MS;
    const window = this.buckets.filter((b) => b.timestamp >= cutoff);

    let totalRequests = 0;
    let totalErrors = 0;
    let creditDeductionFailures = 0;
    const capReqs: Record<string, number> = {};
    const capErrs: Record<string, number> = {};

    for (const b of window) {
      totalRequests += b.gatewayRequests;
      totalErrors += b.gatewayErrors;
      creditDeductionFailures += b.creditDeductionFailures;
      for (const [cap, count] of Object.entries(b.capabilityRequests)) {
        capReqs[cap] = (capReqs[cap] ?? 0) + count;
      }
      for (const [cap, count] of Object.entries(b.capabilityErrors)) {
        capErrs[cap] = (capErrs[cap] ?? 0) + count;
      }
    }

    const capabilityErrorRates: Record<string, number> = {};
    for (const cap of Object.keys(capErrs)) {
      const reqs = capReqs[cap] ?? 0;
      capabilityErrorRates[cap] = reqs > 0 ? (capErrs[cap] / reqs) * 100 : 0;
    }

    return {
      totalRequests,
      totalErrors,
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
      creditDeductionFailures,
      capabilityErrorRates,
    };
  }

  /** Raw buckets for dashboard display. */
  getBuckets(): readonly MetricsBucket[] {
    this.prune();
    return this.buckets;
  }
}
