export interface CircuitBreakerEntry {
  instanceId: string;
  count: number;
  windowStart: number;
  trippedAt: number | null;
}
