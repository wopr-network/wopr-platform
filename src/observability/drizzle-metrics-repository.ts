import { gt, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { gatewayMetrics } from "../db/schema/index.js";
import type { IMetricsRepository, WindowResult } from "./metrics-repository.js";

const MAX_RETENTION_MINUTES = 120;

export class DrizzleMetricsRepository implements IMetricsRepository {
  constructor(private readonly db: DrizzleDb) {}

  private minuteKey(): number {
    const now = Date.now();
    return now - (now % 60_000);
  }

  recordGatewayRequest(capability: string): void {
    const minuteKey = this.minuteKey();
    this.db
      .insert(gatewayMetrics)
      .values({ minuteKey, capability, requests: 1, errors: 0, creditFailures: 0 })
      .onConflictDoUpdate({
        target: [gatewayMetrics.minuteKey, gatewayMetrics.capability],
        set: { requests: sql`${gatewayMetrics.requests} + 1` },
      })
      .run();
    this.pruneOld();
  }

  recordGatewayError(capability: string): void {
    const minuteKey = this.minuteKey();
    this.db
      .insert(gatewayMetrics)
      .values({ minuteKey, capability, requests: 0, errors: 1, creditFailures: 0 })
      .onConflictDoUpdate({
        target: [gatewayMetrics.minuteKey, gatewayMetrics.capability],
        set: { errors: sql`${gatewayMetrics.errors} + 1` },
      })
      .run();
    this.pruneOld();
  }

  recordCreditDeductionFailure(): void {
    const minuteKey = this.minuteKey();
    // Use a synthetic capability key for credit failures
    const capability = "__credit_failures__";
    this.db
      .insert(gatewayMetrics)
      .values({ minuteKey, capability, requests: 0, errors: 0, creditFailures: 1 })
      .onConflictDoUpdate({
        target: [gatewayMetrics.minuteKey, gatewayMetrics.capability],
        set: { creditFailures: sql`${gatewayMetrics.creditFailures} + 1` },
      })
      .run();
    this.pruneOld();
  }

  getWindow(minutes: number): WindowResult {
    const cutoff = Date.now() - minutes * 60_000;
    const rows = this.db.select().from(gatewayMetrics).where(gt(gatewayMetrics.minuteKey, cutoff)).all();

    const byCapability = new Map<string, { requests: number; errors: number }>();
    let totalRequests = 0;
    let totalErrors = 0;
    let creditDeductionFailures = 0;

    for (const row of rows) {
      if (row.capability === "__credit_failures__") {
        creditDeductionFailures += row.creditFailures;
        continue;
      }

      const existing = byCapability.get(row.capability) ?? { requests: 0, errors: 0 };
      existing.requests += row.requests;
      existing.errors += row.errors;
      byCapability.set(row.capability, existing);
      totalRequests += row.requests;
      totalErrors += row.errors;
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

  prune(maxRetentionMinutes: number): number {
    const cutoff = Date.now() - maxRetentionMinutes * 60_000;
    const result = this.db.delete(gatewayMetrics).where(lt(gatewayMetrics.minuteKey, cutoff)).run();
    return result.changes;
  }

  private pruneOld(): void {
    const cutoff = Date.now() - MAX_RETENTION_MINUTES * 60_000;
    this.db.delete(gatewayMetrics).where(lt(gatewayMetrics.minuteKey, cutoff)).run();
  }
}
