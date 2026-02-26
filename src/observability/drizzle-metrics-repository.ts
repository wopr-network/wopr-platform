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

  async recordGatewayRequest(capability: string): Promise<void> {
    const minuteKey = this.minuteKey();
    await this.db
      .insert(gatewayMetrics)
      .values({ minuteKey, capability, requests: 1, errors: 0, creditFailures: 0 })
      .onConflictDoUpdate({
        target: [gatewayMetrics.minuteKey, gatewayMetrics.capability],
        set: { requests: sql`${gatewayMetrics.requests} + 1` },
      });
    void this.pruneOld();
  }

  async recordGatewayError(capability: string): Promise<void> {
    const minuteKey = this.minuteKey();
    await this.db
      .insert(gatewayMetrics)
      .values({ minuteKey, capability, requests: 0, errors: 1, creditFailures: 0 })
      .onConflictDoUpdate({
        target: [gatewayMetrics.minuteKey, gatewayMetrics.capability],
        set: { errors: sql`${gatewayMetrics.errors} + 1` },
      });
    void this.pruneOld();
  }

  async recordCreditDeductionFailure(): Promise<void> {
    const minuteKey = this.minuteKey();
    // Use a synthetic capability key for credit failures
    const capability = "__credit_failures__";
    await this.db
      .insert(gatewayMetrics)
      .values({ minuteKey, capability, requests: 0, errors: 0, creditFailures: 1 })
      .onConflictDoUpdate({
        target: [gatewayMetrics.minuteKey, gatewayMetrics.capability],
        set: { creditFailures: sql`${gatewayMetrics.creditFailures} + 1` },
      });
    void this.pruneOld();
  }

  async getWindow(minutes: number): Promise<WindowResult> {
    const cutoff = Date.now() - minutes * 60_000;
    const rows = await this.db.select().from(gatewayMetrics).where(gt(gatewayMetrics.minuteKey, cutoff));

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

  async prune(maxRetentionMinutes: number): Promise<number> {
    const cutoff = Date.now() - maxRetentionMinutes * 60_000;
    const result = await this.db
      .delete(gatewayMetrics)
      .where(lt(gatewayMetrics.minuteKey, cutoff))
      .returning({ key: gatewayMetrics.minuteKey });
    return result.length;
  }

  private async pruneOld(): Promise<void> {
    const cutoff = Date.now() - MAX_RETENTION_MINUTES * 60_000;
    await this.db.delete(gatewayMetrics).where(lt(gatewayMetrics.minuteKey, cutoff));
  }
}
