export interface BotApplicationMetrics {
  requestCount: number;
  errorCount: number;
  /** P50 latency in milliseconds */
  latencyP50Ms: number;
  /** P95 latency in milliseconds */
  latencyP95Ms: number;
  /** Average latency in milliseconds */
  latencyAvgMs: number;
}

const MAX_LATENCY_SAMPLES = 1000;

interface BotMetricsEntry {
  requestCount: number;
  errorCount: number;
  latencies: number[];
}

export class BotMetricsTracker {
  private readonly bots = new Map<string, BotMetricsEntry>();

  recordRequest(botId: string, latencyMs: number): void {
    let entry = this.bots.get(botId);
    if (!entry) {
      entry = { requestCount: 0, errorCount: 0, latencies: [] };
      this.bots.set(botId, entry);
    }
    entry.requestCount++;
    if (entry.latencies.length >= MAX_LATENCY_SAMPLES) {
      entry.latencies.shift();
    }
    entry.latencies.push(latencyMs);
  }

  recordError(botId: string): void {
    let entry = this.bots.get(botId);
    if (!entry) {
      entry = { requestCount: 0, errorCount: 0, latencies: [] };
      this.bots.set(botId, entry);
    }
    entry.errorCount++;
  }

  getMetrics(botId: string): BotApplicationMetrics | null {
    const entry = this.bots.get(botId);
    if (!entry) return null;

    const sorted = [...entry.latencies].sort((a, b) => a - b);
    const len = sorted.length;
    const p50 = len > 0 ? (sorted[Math.floor((len - 1) * 0.5)] ?? 0) : 0;
    const p95 = len > 0 ? (sorted[Math.floor((len - 1) * 0.95)] ?? 0) : 0;
    const avg = len > 0 ? Math.round((sorted.reduce((s, v) => s + v, 0) / len) * 10) / 10 : 0;

    return {
      requestCount: entry.requestCount,
      errorCount: entry.errorCount,
      latencyP50Ms: p50,
      latencyP95Ms: p95,
      latencyAvgMs: avg,
    };
  }

  reset(botId: string): void {
    this.bots.delete(botId);
  }
}
