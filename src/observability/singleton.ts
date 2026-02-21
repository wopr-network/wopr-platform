import { MetricsCollector } from "./metrics.js";

let _metrics: MetricsCollector | null = null;

export function initMetrics(windowMinutes = 60): MetricsCollector {
  _metrics = new MetricsCollector(windowMinutes);
  return _metrics;
}

export function getMetrics(): MetricsCollector {
  if (!_metrics) {
    // Fallback for tests or when observability hasn't been initialized
    _metrics = new MetricsCollector(60);
  }
  return _metrics;
}
