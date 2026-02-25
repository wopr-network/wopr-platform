export interface LoadTestResult {
  scenarioName: string;
  totalEvents: number;
  durationMs: number;
  eventsPerSec: number;
  p50LatencyUs: number;
  p95LatencyUs: number;
  p99LatencyUs: number;
  peakMemoryMb: number;
  errorCount: number;
  errorRate: number;
}

export interface PipelineReport {
  timestamp: string;
  scenarios: LoadTestResult[];
  bottlenecks: string[];
  scalingLimits: { component: string; maxEventsPerSec: number; limitingFactor: string }[];
}

/** Measure latency of a synchronous function in microseconds. */
export function measureLatencyUs(fn: () => void): number {
  const start = performance.now();
  fn();
  return (performance.now() - start) * 1000;
}

/** Compute percentile from a sorted array of numbers. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Get current heap usage in MB. */
export function heapMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

/** Format a LoadTestResult as a readable string. */
export function formatResult(r: LoadTestResult): string {
  return [
    `--- ${r.scenarioName} ---`,
    `  Events: ${r.totalEvents} in ${r.durationMs.toFixed(0)}ms (${r.eventsPerSec.toFixed(0)} evt/s)`,
    `  Latency: p50=${r.p50LatencyUs.toFixed(0)}us p95=${r.p95LatencyUs.toFixed(0)}us p99=${r.p99LatencyUs.toFixed(0)}us`,
    `  Memory peak: ${r.peakMemoryMb.toFixed(1)}MB`,
    `  Errors: ${r.errorCount} (${(r.errorRate * 100).toFixed(2)}%)`,
  ].join("\n");
}

/** Run a sustained load scenario, returning metrics. */
export function runSustainedLoad(opts: {
  name: string;
  emitFn: () => void;
  totalEvents: number;
  flushFn?: () => void;
  flushEvery?: number;
}): LoadTestResult {
  const latencies: number[] = [];
  let errorCount = 0;
  const startMem = heapMb();
  let peakMem = startMem;

  const start = performance.now();

  for (let i = 0; i < opts.totalEvents; i++) {
    try {
      const lat = measureLatencyUs(opts.emitFn);
      latencies.push(lat);
    } catch {
      errorCount++;
    }

    if (opts.flushFn && opts.flushEvery && (i + 1) % opts.flushEvery === 0) {
      opts.flushFn();
    }

    if (i % 10000 === 0) {
      const mem = heapMb();
      if (mem > peakMem) peakMem = mem;
    }
  }

  // Final flush
  if (opts.flushFn) {
    opts.flushFn();
  }

  const durationMs = performance.now() - start;
  const finalMem = heapMb();
  if (finalMem > peakMem) peakMem = finalMem;

  latencies.sort((a, b) => a - b);

  return {
    scenarioName: opts.name,
    totalEvents: opts.totalEvents,
    durationMs,
    eventsPerSec: (opts.totalEvents / durationMs) * 1000,
    p50LatencyUs: percentile(latencies, 50),
    p95LatencyUs: percentile(latencies, 95),
    p99LatencyUs: percentile(latencies, 99),
    peakMemoryMb: peakMem,
    errorCount,
    errorRate: errorCount / opts.totalEvents,
  };
}
